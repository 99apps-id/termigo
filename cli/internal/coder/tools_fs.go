package coder

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// resolvePath turns an argument into an absolute path against the workspace.
func resolvePath(env *Env, raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			trimmed = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(trimmed, "~"), string(filepath.Separator)))
		}
	}
	if filepath.IsAbs(trimmed) {
		return filepath.Clean(trimmed)
	}
	if strings.TrimSpace(env.Workspace) == "" {
		return filepath.Clean(trimmed)
	}
	return filepath.Clean(filepath.Join(env.Workspace, trimmed))
}

// displayPath shortens an absolute path to a workspace-relative one.
func displayPath(env *Env, path string) string {
	if strings.TrimSpace(env.Workspace) == "" {
		return path
	}
	relative, err := filepath.Rel(env.Workspace, path)
	if err != nil || strings.HasPrefix(relative, "..") {
		return path
	}
	return filepath.ToSlash(relative)
}

// checkWorkspacePath returns an error if the resolved path escapes the
// workspace. When there is no workspace the path is accepted as-is.
func checkWorkspacePath(env *Env, path string) error {
	if strings.TrimSpace(env.Workspace) == "" {
		return nil
	}
	workspace, err := filepath.Abs(env.Workspace)
	if err != nil {
		return fmt.Errorf("cannot resolve workspace: %w", err)
	}
	workspace, err = filepath.EvalSymlinks(workspace)
	if err != nil {
		return fmt.Errorf("cannot resolve workspace: %w", err)
	}
	resolved, err := resolveExistingPath(path)
	if err != nil {
		return fmt.Errorf("cannot safely resolve path: %w", err)
	}
	rel, err := filepath.Rel(workspace, resolved)
	if err != nil {
		return fmt.Errorf("cannot resolve path against workspace: %v", err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return fmt.Errorf("path escapes the workspace: %s", displayPath(env, path))
	}
	return nil
}

// resolveExistingPath resolves the nearest existing ancestor before appending
// missing components. This catches symlinks even when a later component does
// not exist yet, as in write_file's create-parent path.
func resolveExistingPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	candidate := filepath.Clean(absolute)
	var missing []string
	for {
		if _, statErr := os.Lstat(candidate); statErr == nil {
			resolved, resolveErr := filepath.EvalSymlinks(candidate)
			if resolveErr != nil {
				return "", fmt.Errorf("unresolvable symlink at %s", candidate)
			}
			resolved, err = filepath.Abs(resolved)
			if err != nil {
				return "", err
			}
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		} else if !os.IsNotExist(statErr) {
			return "", statErr
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return "", fmt.Errorf("no existing ancestor for %s", path)
		}
		missing = append(missing, filepath.Base(candidate))
		candidate = parent
	}
}

// openError explains a filesystem failure in terms the model can act on.
func openError(err error, path string) string {
	if os.IsNotExist(err) {
		return fmt.Sprintf("%s does not exist", path)
	}
	if os.IsPermission(err) {
		return fmt.Sprintf("%s is not readable (permission denied)", path)
	}
	return fmt.Sprintf("%s: %v", path, err)
}

// readFileTool returns a windowed file read.
type readFileTool struct{}

func (t *readFileTool) Name() string      { return "read_file" }
func (t *readFileTool) Aliases() []string { return []string{"read", "cat"} }
func (t *readFileTool) Mutating() bool    { return false }
func (t *readFileTool) Risk() Risk        { return RiskEdit }
func (t *readFileTool) Label(a map[string]any) string {
	return "Reading " + displayName(a)
}
func (t *readFileTool) DoneLabel(a map[string]any) string {
	return "Read " + displayName(a)
}
func (t *readFileTool) Description() string {
	return "Read a UTF-8 text file. Returns the content plus total line count. Use offset and limit for large files."
}
func (t *readFileTool) Schema() map[string]any {
	return object(map[string]any{
		"path":   strProp("File path, absolute or relative to the workspace."),
		"offset": intProp("First line to read, 1-based. Defaults to 1."),
		"limit":  intProp("Maximum lines to read, 1 to 10000. Defaults to 2000."),
	}, "path")
}

// maxReadLines and maxReadBytes bound one read so a huge file cannot flood
// the model context in a single call.
const (
	maxReadLines = 2000
	maxReadBytes = 64 * 1024
)

// listDirectoryTool lists one directory level.
type listDirectoryTool struct{}

func (t *listDirectoryTool) Name() string      { return "list_directory" }
func (t *listDirectoryTool) Aliases() []string { return []string{"ls", "dir"} }
func (t *listDirectoryTool) Mutating() bool    { return false }
func (t *listDirectoryTool) Risk() Risk        { return RiskEdit }
func (t *listDirectoryTool) Label(a map[string]any) string {
	return "Listing " + pathOrDot(a)
}
func (t *listDirectoryTool) DoneLabel(a map[string]any) string {
	return "Listed " + pathOrDot(a)
}
func (t *listDirectoryTool) Description() string {
	return "List the immediate entries of a directory. Directories are shown with a trailing slash."
}
func (t *listDirectoryTool) Schema() map[string]any {
	return object(map[string]any{"path": strProp("Directory path, absolute or relative to the workspace.")}, "path")
}

// writeFileTool creates or overwrites a file.
type writeFileTool struct{}

func (t *writeFileTool) Name() string      { return "write_file" }
func (t *writeFileTool) Aliases() []string { return []string{"write", "create_file"} }
func (t *writeFileTool) Mutating() bool    { return true }
func (t *writeFileTool) Risk() Risk        { return RiskEdit }
func (t *writeFileTool) Label(a map[string]any) string {
	return "Writing " + displayName(a)
}
func (t *writeFileTool) DoneLabel(a map[string]any) string {
	return "Wrote " + displayName(a)
}
func (t *writeFileTool) Description() string {
	return "Create a file or replace its whole content. Creates parent directories. Prefer edit for a small change to an existing file."
}
func (t *writeFileTool) Schema() map[string]any {
	return object(map[string]any{
		"path":    strProp("File path, absolute or relative to the workspace."),
		"content": strProp("Full file content. An empty string creates an empty file."),
	}, "path", "content")
}

// createDirectoryTool makes a directory tree.
type createDirectoryTool struct{}

func (t *createDirectoryTool) Name() string      { return "create_directory" }
func (t *createDirectoryTool) Aliases() []string { return []string{"mkdir"} }
func (t *createDirectoryTool) Mutating() bool    { return true }
func (t *createDirectoryTool) Risk() Risk        { return RiskEdit }
func (t *createDirectoryTool) Label(a map[string]any) string {
	return "Creating " + pathOrDot(a)
}
func (t *createDirectoryTool) DoneLabel(a map[string]any) string {
	return "Created " + pathOrDot(a)
}
func (t *createDirectoryTool) Description() string {
	return "Create a directory, including missing parents. Succeeds when it already exists."
}
func (t *createDirectoryTool) Schema() map[string]any {
	return object(map[string]any{"path": strProp("Directory path to create.")}, "path")
}

// deleteFileTool removes a file or directory.
type deleteFileTool struct{}

func (t *deleteFileTool) Name() string      { return "delete_file" }
func (t *deleteFileTool) Aliases() []string { return []string{"rm", "remove"} }
func (t *deleteFileTool) Mutating() bool    { return true }
func (t *deleteFileTool) Risk() Risk        { return RiskEdit }
func (t *deleteFileTool) Label(a map[string]any) string {
	return "Deleting " + pathOrDot(a)
}
func (t *deleteFileTool) DoneLabel(a map[string]any) string {
	return "Deleted " + pathOrDot(a)
}
func (t *deleteFileTool) Description() string {
	return "Delete a file or directory tree. This is not recoverable unless the file is under version control."
}
func (t *deleteFileTool) Schema() map[string]any {
	return object(map[string]any{"path": strProp("File or directory to delete.")}, "path")
}

// moveFileTool renames or moves a path.
type moveFileTool struct{}

func (t *moveFileTool) Name() string      { return "move_file" }
func (t *moveFileTool) Aliases() []string { return []string{"mv", "rename"} }
func (t *moveFileTool) Mutating() bool    { return true }
func (t *moveFileTool) Risk() Risk        { return RiskEdit }
func (t *moveFileTool) Label(a map[string]any) string {
	return "Moving " + BaseName(argString(a, "from", "source"))
}
func (t *moveFileTool) DoneLabel(a map[string]any) string {
	return "Moved " + BaseName(argString(a, "from", "source"))
}
func (t *moveFileTool) Description() string {
	return "Move or rename a file or directory. Refuses to overwrite an existing destination."
}
func (t *moveFileTool) Schema() map[string]any {
	return object(map[string]any{
		"from": strProp("Source path."),
		"to":   strProp("Destination path."),
	}, "from", "to")
}

// BaseName is the last path element, for compact labels.
func BaseName(path string) string {
	return filepath.Base(filepath.FromSlash(strings.TrimSpace(path)))
}

func displayName(args map[string]any) string {
	return BaseName(argString(args, "path", "file"))
}

func pathOrDot(args map[string]any) string {
	value := argString(args, "path", "dir", "directory")
	if strings.TrimSpace(value) == "" {
		return "."
	}
	return value
}

// object builds a JSON Schema object with the given required keys.
//
// A blank name is dropped rather than stored. The required list is a variadic,
// so a call such as object(props, "") reads as "no required keys" but would
// declare a property named "" that nothing can satisfy, and the model is then
// told to send an argument that cannot exist.
func object(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	kept := make([]string, 0, len(required))
	for _, name := range required {
		if strings.TrimSpace(name) != "" {
			kept = append(kept, name)
		}
	}
	if len(kept) > 0 {
		schema["required"] = kept
	}
	return schema
}

func strProp(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func intProp(description string) map[string]any {
	return map[string]any{"type": "integer", "description": description}
}

func boolProp(description string) map[string]any {
	return map[string]any{"type": "boolean", "description": description}
}

func arrayProp(description string, items map[string]any) map[string]any {
	return map[string]any{"type": "array", "description": description, "items": items}
}

// isTextFile rejects obvious binaries so a read returns a hint, not garbage.
func isTextFile(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz",
		".exe", ".dll", ".so", ".dylib", ".bin", ".woff", ".woff2", ".ttf", ".class", ".jar":
		return false
	}
	return true
}

// sortEntries orders directory entries with directories first.
func sortEntries(entries []os.DirEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		leftDir := entries[i].IsDir()
		rightDir := entries[j].IsDir()
		if leftDir != rightDir {
			return leftDir
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})
}
