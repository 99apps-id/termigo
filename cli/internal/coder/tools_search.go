package coder

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// maxSearchFileBytes caps the size of a file a search will read.
const maxSearchFileBytes = 2 * 1024 * 1024

// grepTool searches file contents.
type grepTool struct{}

func (t *grepTool) Name() string      { return "grep" }
func (t *grepTool) Aliases() []string { return []string{"search", "search_files"} }
func (t *grepTool) Mutating() bool    { return false }
func (t *grepTool) Risk() Risk        { return RiskEdit }
func (t *grepTool) Label(a map[string]any) string {
	return "Searching " + Shorten(argString(a, "pattern", "query"), 40)
}
func (t *grepTool) DoneLabel(a map[string]any) string {
	return "Searched " + Shorten(argString(a, "pattern", "query"), 40)
}
func (t *grepTool) Description() string {
	return "Search file contents with a regular expression (RE2 syntax). Skips .git, node_modules and other generated trees. Returns path, line number and the matching line."
}
func (t *grepTool) Schema() map[string]any {
	return object(map[string]any{
		"pattern":          strProp("Regular expression to search for."),
		"path":             strProp("Directory or file to search. Defaults to the workspace."),
		"glob":             strProp("Only search files matching this glob, for example **/*.go or *.ts."),
		"case_insensitive": boolProp("Match without regard to case."),
		"max_results":      intProp("Maximum matches to return, 1 to 500. Defaults to 30."),
	}, "pattern")
}

func (t *grepTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	pattern := argString(args, "pattern", "query")
	if strings.TrimSpace(pattern) == "" {
		return Result{Output: "pattern is required", IsError: true}, nil
	}
	expression := pattern
	if argBool(args, "case_insensitive", false) {
		expression = "(?i)" + expression
	}
	compiled, err := regexp.Compile(expression)
	if err != nil {
		return Result{Output: fmt.Sprintf("invalid regular expression: %v", err), IsError: true}, nil
	}
	root := resolvePath(env, argString(args, "path", "root"))
	if root == "" {
		root = env.Workspace
	}
	if err := checkWorkspacePath(env, root); err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	glob := argString(args, "glob")
	maxResults := argInt(args, "max_results", 30, 1, 500)

	type hit struct {
		path string
		line int
		text string
	}
	hits := make([]hit, 0, maxResults)
	truncated := false

	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if entry.IsDir() {
			if path != root && isSkippedDir(entry.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if glob != "" && !matchGlob(glob, relativeSlash(env, path)) {
			return nil
		}
		if !isTextFile(path) {
			return nil
		}
		info, statErr := entry.Info()
		if statErr != nil || info.Size() > maxSearchFileBytes {
			return nil
		}
		file, openErr := os.Open(path)
		if openErr != nil {
			return nil
		}
		defer file.Close()
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64*1024), 512*1024)
		lineNumber := 0
		for scanner.Scan() {
			lineNumber++
			line := scanner.Text()
			if !compiled.MatchString(line) {
				continue
			}
			if len(hits) >= maxResults {
				truncated = true
				return fs.SkipAll
			}
			hits = append(hits, hit{path: relativeSlash(env, path), line: lineNumber, text: Shorten(line, 200)})
		}
		// scanner.Err() is deliberately not returned here: a single file
		// with a line longer than 512KB (common in minified bundles)
		// should not abort the search of every other file.
		return nil
	})
	if err != nil && err != context.Canceled && err != context.DeadlineExceeded {
		return Result{Output: fmt.Sprintf("search failed: %v", err), IsError: true}, nil
	}

	if len(hits) == 0 {
		return Result{Output: "No matches."}, nil
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "%d match(es)", len(hits))
	if truncated {
		builder.WriteString(" (limit reached)")
	}
	builder.WriteString("\n")
	for _, item := range hits {
		fmt.Fprintf(&builder, "%s:%d: %s\n", item.path, item.line, item.text)
	}
	return Result{Output: strings.TrimRight(builder.String(), "\n")}, nil
}

// globTool finds files by path pattern.
type globTool struct{}

func (t *globTool) Name() string      { return "glob" }
func (t *globTool) Aliases() []string { return []string{"find_files", "ls_files"} }
func (t *globTool) Mutating() bool    { return false }
func (t *globTool) Risk() Risk        { return RiskEdit }
func (t *globTool) Label(a map[string]any) string {
	return "Globbing " + Shorten(argString(a, "pattern", "query"), 40)
}
func (t *globTool) DoneLabel(a map[string]any) string {
	return "Globbed " + Shorten(argString(a, "pattern", "query"), 40)
}
func (t *globTool) Description() string {
	return "Find files by glob pattern, for example **/*.go, src/**/*.ts or *.json. Supports ** for any depth. Skips generated trees."
}
func (t *globTool) Schema() map[string]any {
	return object(map[string]any{
		"pattern":     strProp("Glob pattern, matched against the workspace-relative path."),
		"path":        strProp("Directory to search. Defaults to the workspace."),
		"max_results": intProp("Maximum files to return, 1 to 2000. Defaults to 200."),
	}, "pattern")
}

func (t *globTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	pattern := argString(args, "pattern", "query")
	if strings.TrimSpace(pattern) == "" {
		return Result{Output: "pattern is required", IsError: true}, nil
	}
	root := resolvePath(env, argString(args, "path", "root"))
	if root == "" {
		root = env.Workspace
	}
	if err := checkWorkspacePath(env, root); err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	maxResults := argInt(args, "max_results", 200, 1, 2000)

	matches := make([]string, 0, maxResults)
	truncated := false
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if entry.IsDir() {
			if path != root && isSkippedDir(entry.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !matchGlob(pattern, relativeSlash(env, path)) {
			return nil
		}
		if len(matches) >= maxResults {
			truncated = true
			return fs.SkipAll
		}
		matches = append(matches, relativeSlash(env, path))
		return nil
	})
	if err != nil && err != context.Canceled && err != context.DeadlineExceeded {
		return Result{Output: fmt.Sprintf("glob failed: %v", err), IsError: true}, nil
	}
	if len(matches) == 0 {
		return Result{Output: "No files matched."}, nil
	}
	header := fmt.Sprintf("%d file(s)", len(matches))
	if truncated {
		header += " (limit reached)"
	}
	return Result{Output: header + "\n" + strings.Join(matches, "\n")}, nil
}

func relativeSlash(env *Env, path string) string {
	if strings.TrimSpace(env.Workspace) == "" {
		return filepath.ToSlash(path)
	}
	relative, err := filepath.Rel(env.Workspace, path)
	if err != nil {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(relative)
}

// matchGlob matches a slash-separated path against a glob, where ** spans
// directory boundaries and * does not.
func matchGlob(pattern, path string) bool {
	expression := globToRegex(pattern)
	compiled, err := regexp.Compile("^" + expression + "$")
	if err != nil {
		return false
	}
	if compiled.MatchString(path) {
		return true
	}
	// A bare pattern like *.go should also match at any depth.
	if !strings.Contains(pattern, "/") {
		return compiled.MatchString(filepath.Base(path))
	}
	return false
}

// globToRegex converts a glob to a regular expression.
func globToRegex(pattern string) string {
	var builder strings.Builder
	runes := []rune(strings.TrimPrefix(filepath.ToSlash(pattern), "./"))
	for index := 0; index < len(runes); index++ {
		r := runes[index]
		switch r {
		case '*':
			if index+1 < len(runes) && runes[index+1] == '*' {
				index++
				if index+1 < len(runes) && runes[index+1] == '/' {
					index++
					builder.WriteString("(?:.*/)?")
					continue
				}
				builder.WriteString(".*")
				continue
			}
			builder.WriteString("[^/]*")
		case '?':
			builder.WriteString("[^/]")
		case '.', '+', '(', ')', '|', '^', '$', '{', '}', '[', ']', '\\':
			builder.WriteString("\\" + string(r))
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}
