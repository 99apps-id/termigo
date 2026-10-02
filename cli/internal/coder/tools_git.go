package coder

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// gitCommandTimeout bounds one git invocation.
const gitCommandTimeout = 120 * time.Second

// maxGitOutputChars caps what a git command may return.
const maxGitOutputChars = 24000

// runGit executes git with explicit arguments, never through a shell.
//
// Arguments come from the model, so a shell would turn a file name or a commit
// message into a command. Passing them as separate argv entries is what keeps a
// message such as "fix; rm -rf /" literal text.
func runGit(ctx context.Context, env *Env, args ...string) (string, error) {
	if !isGitRepository(env.Workspace) {
		return "", errors.New("this workspace is not a git repository")
	}
	runCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()

	argv := append([]string{"--no-pager"}, args...)
	command := exec.CommandContext(runCtx, "git", argv...)
	command.Dir = env.Workspace
	var buffer bytes.Buffer
	command.Stdout = &buffer
	command.Stderr = &buffer
	command.Stdin = strings.NewReader("")
	// A hook or credential helper that inherits the output pipe would keep
	// Wait blocked after a cancel; bound that wait the same way run_command does.
	command.WaitDelay = processWaitDelay

	err := command.Run()
	output := strings.TrimRight(buffer.String(), "\n")
	if len(output) > maxGitOutputChars {
		output = clipBytes(output, maxGitOutputChars) + "\n... [output truncated]"
	}
	if runCtx.Err() == context.DeadlineExceeded {
		return output, fmt.Errorf("git %s timed out after %s", strings.Join(args, " "), gitCommandTimeout)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if strings.TrimSpace(output) == "" {
				output = fmt.Sprintf("git exited with code %d", exitErr.ExitCode())
			}
			return output, fmt.Errorf("git %s failed: %s", args[0], output)
		}
		return output, fmt.Errorf("could not run git: %w. Is git installed and on PATH?", err)
	}
	return output, nil
}

// isGitRepository reports whether the workspace is inside a git work tree.
func isGitRepository(workspace string) bool {
	if strings.TrimSpace(workspace) == "" {
		return false
	}
	command := exec.Command("git", "rev-parse", "--is-inside-work-tree")
	command.Dir = workspace
	return command.Run() == nil
}

// gitArgs builds argv from optional flags and paths.
func gitArgs(prefix []string, flags map[string]bool, paths []string) []string {
	args := append([]string{}, prefix...)
	for _, flag := range []string{"--staged", "--stat", "--all"} {
		if flags[flag] {
			args = append(args, flag)
		}
	}
	if len(paths) > 0 {
		args = append(args, "--")
		args = append(args, paths...)
	}
	return args
}

type gitStatusTool struct{}

func (t *gitStatusTool) Name() string                      { return "git_status" }
func (t *gitStatusTool) Aliases() []string                 { return []string{"git_st"} }
func (t *gitStatusTool) Mutating() bool                    { return false }
func (t *gitStatusTool) Risk() Risk                        { return RiskEdit }
func (t *gitStatusTool) Label(a map[string]any) string     { return "Reading git status" }
func (t *gitStatusTool) DoneLabel(a map[string]any) string { return "Read git status" }
func (t *gitStatusTool) Description() string {
	return "Show the working tree status: branch, staged changes, unstaged changes and untracked files. Start here before committing or reverting anything."
}
func (t *gitStatusTool) Schema() map[string]any { return object(map[string]any{}) }

func (t *gitStatusTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	output, err := runGit(ctx, env, "status", "--porcelain=v1", "--branch")
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}

	// Porcelain prints "## main" even when the tree is clean, so the branch
	// header is separated from the changes rather than being reported as one.
	branch := ""
	changes := make([]string, 0, 16)
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(trimmed, "## "):
			branch = strings.TrimPrefix(trimmed, "## ")
		case strings.TrimSpace(trimmed) != "":
			changes = append(changes, trimmed)
		}
	}
	if len(changes) == 0 {
		if branch == "" {
			return Result{Output: "Clean working tree."}, nil
		}
		return Result{Output: "On " + branch + ": clean working tree."}, nil
	}

	var builder strings.Builder
	if branch != "" {
		fmt.Fprintf(&builder, "On %s\n", branch)
	}
	builder.WriteString(strings.Join(changes, "\n"))
	return Result{Output: builder.String()}, nil
}

type gitDiffTool struct{}

func (t *gitDiffTool) Name() string                      { return "git_diff" }
func (t *gitDiffTool) Aliases() []string                 { return []string{"git_difference"} }
func (t *gitDiffTool) Mutating() bool                    { return false }
func (t *gitDiffTool) Risk() Risk                        { return RiskEdit }
func (t *gitDiffTool) Label(a map[string]any) string     { return "Reading git diff" }
func (t *gitDiffTool) DoneLabel(a map[string]any) string { return "Read git diff" }
func (t *gitDiffTool) Description() string {
	return "Show the changes in the working tree, or staged changes with staged=true. Pass a path to limit it to one file."
}
func (t *gitDiffTool) Schema() map[string]any {
	return object(map[string]any{
		"staged": boolProp("Show staged changes instead of unstaged ones."),
		"path":   strProp("Limit the diff to one file or directory."),
		"stat":   boolProp("Show only the summary of added and removed lines."),
	})
}

func (t *gitDiffTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	flags := map[string]bool{
		"--staged": argBool(args, "staged", false),
		"--stat":   argBool(args, "stat", false),
	}
	paths := argList(args, "path", "paths", "files")
	output, err := runGit(ctx, env, gitArgs([]string{"diff"}, flags, paths)...)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	if strings.TrimSpace(output) == "" {
		return Result{Output: "No changes."}, nil
	}
	return Result{Output: output}, nil
}

type gitLogTool struct{}

func (t *gitLogTool) Name() string                      { return "git_log" }
func (t *gitLogTool) Aliases() []string                 { return []string{"git_history"} }
func (t *gitLogTool) Mutating() bool                    { return false }
func (t *gitLogTool) Risk() Risk                        { return RiskEdit }
func (t *gitLogTool) Label(a map[string]any) string     { return "Reading git log" }
func (t *gitLogTool) DoneLabel(a map[string]any) string { return "Read git log" }
func (t *gitLogTool) Description() string {
	return "Show recent commits, newest first. Use it to match the style of the project's existing commit messages before writing one."
}
func (t *gitLogTool) Schema() map[string]any {
	return object(map[string]any{
		"limit": intProp("How many commits to show, 1 to 200. Defaults to 20."),
		"path":  strProp("Limit to commits touching this path."),
	})
}

func (t *gitLogTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	limit := argInt(args, "limit", 20, 1, 200)
	argv := []string{"log", fmt.Sprintf("-%d", limit), "--date=short", "--pretty=format:%h %ad %an: %s"}
	if paths := argList(args, "path", "paths"); len(paths) > 0 {
		argv = append(argv, "--")
		argv = append(argv, paths...)
	}
	output, err := runGit(ctx, env, argv...)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	if strings.TrimSpace(output) == "" {
		return Result{Output: "No commits yet."}, nil
	}
	return Result{Output: output}, nil
}

type gitShowTool struct{}

func (t *gitShowTool) Name() string      { return "git_show" }
func (t *gitShowTool) Aliases() []string { return []string{"git_commit_show"} }
func (t *gitShowTool) Mutating() bool    { return false }
func (t *gitShowTool) Risk() Risk        { return RiskEdit }
func (t *gitShowTool) Label(a map[string]any) string {
	return "Reading commit " + argString(a, "ref")
}
func (t *gitShowTool) DoneLabel(a map[string]any) string {
	return "Read commit " + argString(a, "ref")
}
func (t *gitShowTool) Description() string {
	return "Show one commit, defaulting to HEAD. Use stat=true for the summary instead of the full patch."
}
func (t *gitShowTool) Schema() map[string]any {
	return object(map[string]any{
		"ref":  strProp("Commit, tag or branch. Defaults to HEAD."),
		"stat": boolProp("Show the summary instead of the full diff."),
	})
}

func (t *gitShowTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	ref := strings.TrimSpace(argString(args, "ref", "commit"))
	if ref == "" {
		ref = "HEAD"
	}
	argv := []string{"show"}
	if argBool(args, "stat", false) {
		argv = append(argv, "--stat")
	}
	argv = append(argv, "--end-of-options", ref)
	output, err := runGit(ctx, env, argv...)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	return Result{Output: output}, nil
}

type gitAddTool struct{}

func (t *gitAddTool) Name() string      { return "git_add" }
func (t *gitAddTool) Aliases() []string { return []string{"git_stage"} }
func (t *gitAddTool) Mutating() bool    { return true }
func (t *gitAddTool) Risk() Risk        { return RiskEdit }
func (t *gitAddTool) Label(a map[string]any) string {
	return "Staging " + Shorten(strings.Join(argList(a, "paths", "path", "files"), " "), 50)
}
func (t *gitAddTool) DoneLabel(a map[string]any) string {
	return "Staged " + Shorten(strings.Join(argList(a, "paths", "path", "files"), " "), 50)
}
func (t *gitAddTool) Description() string {
	return "Stage files for the next commit. Pass all_changes=true to stage every change including deletions, which is what a commit of the current work usually wants."
}
func (t *gitAddTool) Schema() map[string]any {
	return object(map[string]any{
		"paths":       arrayProp("Files to stage. Ignored when all_changes is true.", strProp("A path.")),
		"all_changes": boolProp("Stage every change in the repository."),
	})
}

func (t *gitAddTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	if argBool(args, "all_changes", false) {
		output, err := runGit(ctx, env, "add", "--all")
		if err != nil {
			return Result{Output: err.Error(), IsError: true}, nil
		}
		summary := strings.TrimSpace(output)
		if summary == "" {
			summary = "Staged every change."
		}
		return Result{Output: summary}, nil
	}
	paths := argList(args, "paths", "path", "files")
	if len(paths) == 0 {
		return Result{Output: "Give at least one path, or set all_changes=true.", IsError: true}, nil
	}
	argv := append([]string{"add", "--"}, paths...)
	if _, err := runGit(ctx, env, argv...); err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	return Result{Output: "Staged: " + strings.Join(paths, ", ")}, nil
}

type gitCommitTool struct{}

func (t *gitCommitTool) Name() string      { return "git_commit" }
func (t *gitCommitTool) Aliases() []string { return []string{"git_ci"} }
func (t *gitCommitTool) Mutating() bool    { return true }
func (t *gitCommitTool) Risk() Risk        { return RiskEdit }
func (t *gitCommitTool) Label(a map[string]any) string {
	return "Committing: " + Shorten(firstLine(argString(a, "message")), 50)
}
func (t *gitCommitTool) DoneLabel(a map[string]any) string {
	return "Committed: " + Shorten(firstLine(argString(a, "message")), 50)
}
func (t *gitCommitTool) Description() string {
	return "Commit staged changes. Stage first with git_add, or set all_changes=true to stage the whole working tree including new files. Use a message that matches the project's existing style, seen in git_log. This does not push."
}
func (t *gitCommitTool) Schema() map[string]any {
	return object(map[string]any{
		"message":     strProp("Commit message. Meaningful and specific, not 'update'."),
		"all_changes": boolProp("Stage every change in the working tree, including new files, before committing."),
		"paths":       arrayProp("Commit only these paths, leaving other staged work alone.", strProp("A path.")),
	}, "message")
}

func (t *gitCommitTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	message := strings.TrimSpace(argString(args, "message"))
	if message == "" {
		return Result{Output: "message is required", IsError: true}, nil
	}
	// `git commit --all` stages tracked modifications only. A file the agent
	// just wrote is untracked, so a commit that claims to include everything
	// would silently omit the very change that mattered. Staging explicitly is
	// what makes the flag mean what it says.
	if argBool(args, "all_changes", false) {
		if _, err := runGit(ctx, env, "add", "--all"); err != nil {
			return Result{Output: err.Error(), IsError: true}, nil
		}
	}

	argv := []string{"commit", "-m", message}
	if paths := argList(args, "paths", "path", "files"); len(paths) > 0 {
		argv = append(argv, "--")
		argv = append(argv, paths...)
	}
	output, err := runGit(ctx, env, argv...)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	return Result{Output: output}, nil
}

type gitBranchTool struct{}

func (t *gitBranchTool) Name() string      { return "git_branch" }
func (t *gitBranchTool) Aliases() []string { return []string{"git_checkout"} }
func (t *gitBranchTool) Mutating() bool    { return true }
func (t *gitBranchTool) Risk() Risk        { return RiskEdit }
func (t *gitBranchTool) Label(a map[string]any) string {
	return "Branch " + argString(a, "name")
}
func (t *gitBranchTool) DoneLabel(a map[string]any) string {
	return "Branched " + argString(a, "name")
}
func (t *gitBranchTool) Description() string {
	return "List branches, switch to one, or create one. Uncommitted changes can block a switch, so commit or stash first."
}
func (t *gitBranchTool) Schema() map[string]any {
	return object(map[string]any{
		"name":   strProp("Branch to switch to. Omit to list branches."),
		"create": boolProp("Create the branch before switching, as if -b were passed."),
	})
}

func (t *gitBranchTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	name := strings.TrimSpace(argString(args, "name", "branch"))
	if name == "" {
		output, err := runGit(ctx, env, "branch", "--list", "--format=%(refname:short) %(objectname:short)")
		if err != nil {
			return Result{Output: err.Error(), IsError: true}, nil
		}
		return Result{Output: output}, nil
	}
	argv := []string{"checkout"}
	if argBool(args, "create", false) {
		// `-b <name>` consumes the name as its argument, which git validates,
		// so a name that looks like an option is rejected rather than obeyed.
		argv = append(argv, "-b", name)
	} else {
		// A switch target the model supplied must not reach git as an option:
		// a name such as -f would force-switch and discard local changes.
		argv = append(argv, "--end-of-options", name)
	}
	output, err := runGit(ctx, env, argv...)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	return Result{Output: output}, nil
}

type gitRestoreTool struct{}

func (t *gitRestoreTool) Name() string      { return "git_restore" }
func (t *gitRestoreTool) Aliases() []string { return []string{"git_revert", "git_undo"} }
func (t *gitRestoreTool) Mutating() bool    { return true }
func (t *gitRestoreTool) Risk() Risk        { return RiskEdit }
func (t *gitRestoreTool) Label(a map[string]any) string {
	return "Restoring " + Shorten(strings.Join(argList(a, "paths", "path", "files"), " "), 50)
}
func (t *gitRestoreTool) DoneLabel(a map[string]any) string {
	return "Restored " + Shorten(strings.Join(argList(a, "paths", "path", "files"), " "), 50)
}
func (t *gitRestoreTool) Description() string {
	return "Discard changes to tracked files, returning them to the last commit. Use staged=true to unstage instead of discarding. This loses work, so say what you are reverting before you do it."
}
func (t *gitRestoreTool) Schema() map[string]any {
	return object(map[string]any{
		"paths":  arrayProp("Files to restore.", strProp("A path.")),
		"staged": boolProp("Unstage instead of discarding the working tree change."),
	})
}

func (t *gitRestoreTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	paths := argList(args, "paths", "path", "files")
	if len(paths) == 0 {
		return Result{Output: "Give at least one path; refusing to discard every change at once.", IsError: true}, nil
	}
	argv := []string{"restore"}
	if argBool(args, "staged", false) {
		argv = append(argv, "--staged")
	}
	argv = append(argv, "--")
	argv = append(argv, paths...)
	output, err := runGit(ctx, env, argv...)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	summary := "Restored: " + strings.Join(paths, ", ")
	if strings.TrimSpace(output) != "" {
		summary += "\n" + output
	}
	return Result{Output: summary}, nil
}

type gitBlameTool struct{}

func (t *gitBlameTool) Name() string      { return "git_blame" }
func (t *gitBlameTool) Aliases() []string { return []string{"blame"} }
func (t *gitBlameTool) Mutating() bool    { return false }
func (t *gitBlameTool) Risk() Risk        { return RiskEdit }
func (t *gitBlameTool) Label(a map[string]any) string {
	return "Reading git blame " + Shorten(argString(a, "path"), 50)
}
func (t *gitBlameTool) DoneLabel(a map[string]any) string {
	return "Read git blame " + Shorten(argString(a, "path"), 50)
}
func (t *gitBlameTool) Description() string {
	return "Show what revision and author last modified each line of a file. Supports line ranges (start_line, end_line) and revision."
}
func (t *gitBlameTool) Schema() map[string]any {
	return object(map[string]any{
		"path":       strProp("File path to blame."),
		"start_line": intProp("First line of the range to blame (1-based)."),
		"end_line":   intProp("Last line of the range to blame (1-based)."),
		"revision":   strProp("Commit or revision to blame."),
	}, "path")
}

func (t *gitBlameTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	path := argString(args, "path", "file")
	if strings.TrimSpace(path) == "" {
		return Result{Output: "Path is required.", IsError: true}, nil
	}
	resolved := resolvePath(env, path)
	if err := checkWorkspacePath(env, resolved); err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}

	argv := []string{"blame"}
	startLine := argInt(args, "start_line", 0, 1, 1000000)
	endLine := argInt(args, "end_line", 0, 1, 1000000)
	if startLine > 0 && endLine > 0 {
		if startLine > endLine {
			return Result{Output: "start_line must be less than or equal to end_line.", IsError: true}, nil
		}
		argv = append(argv, fmt.Sprintf("-L%d,%d", startLine, endLine))
	} else if startLine > 0 {
		argv = append(argv, fmt.Sprintf("-L%d,", startLine))
	} else if endLine > 0 {
		argv = append(argv, fmt.Sprintf("-L1,%d", endLine))
	}

	if rev := strings.TrimSpace(argString(args, "revision", "rev", "commit")); rev != "" {
		// A revision is model-supplied and must not reach git as an option. A
		// real revision never starts with a dash, so refusing one keeps it out
		// of the option position while the path stays behind --.
		if strings.HasPrefix(rev, "-") {
			return Result{Output: fmt.Sprintf("invalid revision %q", rev), IsError: true}, nil
		}
		argv = append(argv, rev)
	}

	relPath := displayPath(env, resolved)
	argv = append(argv, "--", relPath)

	output, err := runGit(ctx, env, argv...)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	if strings.TrimSpace(output) == "" {
		return Result{Output: "No blame output."}, nil
	}
	return Result{Output: output}, nil
}

// firstLine is the subject line of a commit message, for compact labels.
func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		return strings.TrimSpace(text[:index])
	}
	return strings.TrimSpace(text)
}
