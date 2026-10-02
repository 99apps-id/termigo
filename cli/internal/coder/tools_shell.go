package coder

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// runCommandTool executes a shell command in the workspace.
type runCommandTool struct{}

func (t *runCommandTool) Name() string      { return "run_command" }
func (t *runCommandTool) Aliases() []string { return []string{"bash", "bash_run", "shell", "exec"} }
func (t *runCommandTool) Mutating() bool    { return true }
func (t *runCommandTool) Risk() Risk        { return RiskCommand }
func (t *runCommandTool) Label(a map[string]any) string {
	return "Running " + Shorten(argString(a, "command"), 60)
}
func (t *runCommandTool) DoneLabel(a map[string]any) string {
	return "Ran " + Shorten(argString(a, "command"), 60)
}
func (t *runCommandTool) Description() string {
	return "Run a shell command in the workspace and return its combined output and exit code. On Windows it runs through PowerShell; on macOS and Linux through sh. Use it for builds, tests, formatters and linters such as biome, vitest, go test or cargo."
}
func (t *runCommandTool) Schema() map[string]any {
	return object(map[string]any{
		"command":      strProp("Command line to run."),
		"cwd":          strProp("Working directory. Defaults to the workspace root."),
		"timeout_secs": intProp("Timeout in seconds, 1 to 900. Defaults to 120; install and build commands get at least 300."),
	}, "command")
}

// defaultCommandTimeout and maxCommandTimeout bound one command.
const (
	defaultCommandTimeout = 120
	maxCommandTimeout     = 900
	installTimeoutFloor   = 300
	maxOutputChars        = 16000
)

func (t *runCommandTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	command := strings.TrimSpace(argString(args, "command"))
	if command == "" {
		return Result{Output: "command is required", IsError: true}, nil
	}
	timeout := argInt(args, "timeout_secs", defaultCommandTimeout, 1, maxCommandTimeout)
	if looksLikeInstall(command) && timeout < installTimeoutFloor {
		timeout = installTimeoutFloor
	}
	dir := resolvePath(env, argString(args, "cwd"))
	if dir == "" {
		dir = env.Workspace
	}
	if err := checkWorkspacePath(env, dir); err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return Result{Output: fmt.Sprintf("working directory %s is not available", dir), IsError: true}, nil
	}
	return execute(ctx, env, command, dir, time.Duration(timeout)*time.Second)
}

// looksLikeInstall raises the floor for commands that are expected to be slow.
func looksLikeInstall(command string) bool {
	lower := strings.ToLower(command)
	for _, needle := range []string{"install", "cargo build", "cargo test", "git clone", "go build", "go test", "pnpm i", "npm i", "yarn", "pip install"} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

// runChecksTool runs the project's own test, lint or build command.
type runChecksTool struct{}

func (t *runChecksTool) Name() string      { return "run_checks" }
func (t *runChecksTool) Aliases() []string { return []string{"verify", "test", "lint"} }
func (t *runChecksTool) Mutating() bool    { return true }
func (t *runChecksTool) Risk() Risk        { return RiskCommand }
func (t *runChecksTool) Label(a map[string]any) string {
	return "Running checks (" + argString(a, "kind") + ")"
}
func (t *runChecksTool) DoneLabel(a map[string]any) string {
	return "Ran checks (" + argString(a, "kind") + ")"
}
func (t *runChecksTool) Description() string {
	return "Run the project's tests, linter, formatter, type checker or build, detected from go.mod, package.json, Cargo.toml or pyproject.toml. Prefer this over hand-written commands so the project's own tooling is used."
}
func (t *runChecksTool) Schema() map[string]any {
	return object(map[string]any{
		"kind":         map[string]any{"type": "string", "enum": []string{"test", "lint", "format", "typecheck", "build"}, "description": "Which check to run. Defaults to test."},
		"command":      strProp("Explicit command that overrides detection."),
		"timeout_secs": intProp("Timeout in seconds, 1 to 900. Defaults to 300."),
	})
}

func (t *runChecksTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	kind := strings.ToLower(strings.TrimSpace(argString(args, "kind")))
	if kind == "" {
		kind = "test"
	}
	switch kind {
	case "test", "lint", "format", "typecheck", "build":
	default:
		return Result{Output: fmt.Sprintf("unknown check %q; use test, lint, format, typecheck or build", kind), IsError: true}, nil
	}
	command := strings.TrimSpace(argString(args, "command"))
	if command == "" {
		detected, ok := detectCheckCommand(env.Workspace, kind)
		if !ok {
			return Result{Output: fmt.Sprintf("No %s command could be detected for this project. Pass an explicit command.", kind), IsError: true}, nil
		}
		command = detected
	}
	timeout := argInt(args, "timeout_secs", 300, 1, maxCommandTimeout)
	result, err := execute(ctx, env, command, env.Workspace, time.Duration(timeout)*time.Second)
	if err != nil {
		return result, err
	}
	result.Output = fmt.Sprintf("$ %s\n%s", command, result.Output)
	return result, nil
}

// shellForTool picks the interpreter for a foreground command. It is a
// variable so tests can substitute a cheap shell, for the same reason as
// shellForProcess.
var shellForTool = shellInvocation

// execute runs one command line and folds the outcome into a Result.
func execute(ctx context.Context, env *Env, command, dir string, timeout time.Duration) (Result, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	shell, shellArgs := shellForTool(command)
	process := exec.CommandContext(runCtx, shell, shellArgs...)
	process.Dir = dir
	var buffer bytes.Buffer
	process.Stdout = &buffer
	process.Stderr = &buffer
	process.Stdin = strings.NewReader("")

	// Group the command with everything it starts, so a cancel or a timeout
	// stops the whole tree rather than only the shell. Killing the shell alone
	// left a grandchild such as `du` running and holding the output pipe open,
	// so Wait never returned and a stopped turn stayed stuck until the child
	// finished on its own.
	tree, treeErr := newProcessTree()
	if treeErr == nil {
		tree.prepare(process)
		process.Cancel = func() error {
			if err := tree.terminate(process); err == nil {
				return nil
			}
			if process.Process != nil {
				return process.Process.Kill()
			}
			return nil
		}
	}
	// A grandchild that inherits the pipe keeps it open after the direct child
	// is killed; WaitDelay bounds that wait so a stop is prompt.
	process.WaitDelay = processWaitDelay

	if err := process.Start(); err != nil {
		if tree != nil {
			tree.release()
		}
		return Result{Output: fmt.Sprintf("Could not start the command: %v", err), IsError: true}, nil
	}
	if tree != nil {
		_ = tree.attach(process)
		defer tree.release()
	}

	runErr := process.Wait()
	output := truncateOutput(buffer.String(), maxOutputChars)
	label := displayPath(env, dir)

	if runCtx.Err() == context.DeadlineExceeded {
		return Result{
			Output:  fmt.Sprintf("Command timed out after %s in %s\n%s", timeout, label, output),
			IsError: true,
		}, nil
	}
	if ctx.Err() != nil {
		return Result{Output: "Command cancelled.", IsError: true}, nil
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			message := fmt.Sprintf("Command exited with code %d in %s\n%s", exitErr.ExitCode(), label, output)
			return Result{Output: message, IsError: true}, nil
		}
		return Result{Output: fmt.Sprintf("Could not run the command: %v", runErr), IsError: true}, nil
	}
	if strings.TrimSpace(output) == "" {
		output = "(no output)"
	}
	return Result{Output: fmt.Sprintf("Command succeeded in %s\n%s", label, output)}, nil
}

// shellInvocation picks the interpreter that matches the platform.
func shellInvocation(command string) (string, []string) {
	if runtime.GOOS == "windows" {
		return "powershell.exe", windowsShell(command)
	}
	return posixShell(command, exec.LookPath)
}

// windowsShell is split out so the flags are readable as a list.
func windowsShell(command string) []string {
	return []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command}
}

// posixShell prefers bash for a login shell, which is what picks up a version
// manager, and falls back to sh. The lookup is a parameter so both branches are
// testable from either platform.
func posixShell(command string, lookup func(string) (string, error)) (string, []string) {
	if bash, err := lookup("bash"); err == nil {
		return bash, []string{"-lc", command}
	}
	return "/bin/sh", []string{"-c", command}
}

// truncateOutput keeps the head and the tail of a long output, which is where
// the useful lines are: the command echo at the top, the failure at the end.
func truncateOutput(text string, max int) string {
	if len(text) <= max {
		return strings.TrimRight(text, "\n")
	}
	half := max / 2
	head := clipBytes(text, half)
	tail := clipTailBytes(text, half)
	return strings.TrimRight(head, "\n") + fmt.Sprintf("\n\n... [%d characters omitted] ...\n\n", len(text)-max) + strings.TrimLeft(tail, "\n")
}

// detectCheckCommand finds the project's own command for a check.
func detectCheckCommand(workspace, kind string) (string, bool) {
	if strings.TrimSpace(workspace) == "" {
		return "", false
	}
	if exists(filepath.Join(workspace, "go.mod")) {
		switch kind {
		case "test":
			return "go test ./...", true
		case "lint":
			return "go vet ./...", true
		case "format":
			return "gofmt -l .", true
		case "typecheck":
			return "go build ./...", true
		case "build":
			return "go build ./...", true
		}
	}
	if exists(filepath.Join(workspace, "Cargo.toml")) {
		switch kind {
		case "test":
			return "cargo test", true
		case "lint":
			return "cargo clippy --all-targets", true
		case "format":
			return "cargo fmt --check", true
		case "typecheck":
			return "cargo check", true
		case "build":
			return "cargo build", true
		}
	}
	if scripts, ok := readPackageScripts(workspace); ok {
		runner := nodeRunner(workspace)
		for _, candidate := range scriptNamesFor(kind) {
			if _, present := scripts[candidate]; present {
				return runner + " run " + candidate, true
			}
		}
		if kind == "test" {
			return runner + " test", true
		}
	}
	if exists(filepath.Join(workspace, "pyproject.toml")) || exists(filepath.Join(workspace, "pytest.ini")) {
		switch kind {
		case "test":
			return "python -m pytest", true
		case "lint":
			return "python -m ruff check .", true
		case "format":
			return "python -m ruff format --check .", true
		}
	}
	return "", false
}

func scriptNamesFor(kind string) []string {
	switch kind {
	case "test":
		return []string{"test", "tests", "vitest"}
	case "lint":
		return []string{"lint", "biome", "eslint", "check"}
	case "format":
		return []string{"format", "fmt", "prettier"}
	case "typecheck":
		return []string{"typecheck", "check-types", "tsc"}
	case "build":
		return []string{"build", "compile"}
	}
	return nil
}

func nodeRunner(workspace string) string {
	switch {
	case exists(filepath.Join(workspace, "pnpm-lock.yaml")):
		return "pnpm"
	case exists(filepath.Join(workspace, "yarn.lock")):
		return "yarn"
	case exists(filepath.Join(workspace, "bun.lockb")), exists(filepath.Join(workspace, "bun.lock")):
		return "bun"
	default:
		return "npm"
	}
}

func readPackageScripts(workspace string) (map[string]string, bool) {
	data, err := os.ReadFile(filepath.Join(workspace, "package.json"))
	if err != nil {
		return nil, false
	}
	var parsed struct {
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(data, &parsed) != nil {
		return nil, false
	}
	return parsed.Scripts, true
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
