package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const maxWorkspaceEntries = 2500

var ignoredDirectories = map[string]bool{
	".git": true, ".idea": true, ".next": true, ".turbo": true,
	"dist": true, "node_modules": true, "vendor": true,
}

// App owns the local-only services exposed to the desktop interface.
type App struct {
	ctx              context.Context
	mu               sync.RWMutex
	workspace        string
	terminalMu       sync.Mutex
	terminal         *terminalSession
	terminalSequence uint64
}

type FileNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	IsDir    bool       `json:"isDir"`
	Children []FileNode `json:"children,omitempty"`
}

type Workspace struct {
	Path string     `json:"path"`
	Tree []FileNode `json:"tree"`
}

type FileDocument struct {
	Path     string `json:"path"`
	Contents string `json:"contents"`
	Language string `json:"language"`
}

type CLIStatus struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Command   string `json:"command"`
	Available bool   `json:"available"`
	Version   string `json:"version"`
}

// NewApp creates the local application services.
func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) shutdown(context.Context) {
	a.stopTerminal("")
}

// OpenWorkspace asks the operating system for a project directory.
func (a *App) OpenWorkspace() (Workspace, error) {
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open workspace",
	})
	if err != nil {
		return Workspace{}, err
	}
	if path == "" {
		return Workspace{}, nil
	}

	path, err = filepath.Abs(path)
	if err != nil {
		return Workspace{}, err
	}

	a.stopTerminal("")
	a.mu.Lock()
	a.workspace = path
	a.mu.Unlock()

	return a.workspaceTree()
}

// CurrentWorkspace returns the active workspace and a freshly read file tree.
func (a *App) CurrentWorkspace() (Workspace, error) {
	if a.workspacePath() == "" {
		return Workspace{}, nil
	}
	return a.workspaceTree()
}

// RefreshWorkspace rereads the active folder without prompting the user again.
// It keeps the explorer in sync after files are added, renamed, or removed from
// the terminal or another application.
func (a *App) RefreshWorkspace() (Workspace, error) {
	return a.CurrentWorkspace()
}

// ReadTextFile reads a UTF-8 source file inside the active workspace.
func (a *App) ReadTextFile(path string) (FileDocument, error) {
	if err := a.validateWorkspacePath(path); err != nil {
		return FileDocument{}, err
	}

	contents, err := os.ReadFile(path)
	if err != nil {
		return FileDocument{}, err
	}
	if bytes.IndexByte(contents, 0) >= 0 {
		return FileDocument{}, errors.New("binary files cannot be opened in the text editor")
	}

	return FileDocument{
		Path:     path,
		Contents: string(contents),
		Language: languageForPath(path),
	}, nil
}

// SaveTextFile writes a document only when it remains inside the active workspace.
func (a *App) SaveTextFile(path, contents string) error {
	if err := a.validateWorkspacePath(path); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(contents), 0o644)
}

// DetectCLIs reports locally available AI and development CLIs without reading
// credentials or transmitting any local data.
func (a *App) DetectCLIs() []CLIStatus {
	targets := []struct {
		id, label, command, versionArgument string
	}{
		{"codex", "Codex CLI", "codex", "--version"},
		{"gemini", "Gemini CLI", "gemini", "--version"},
		{"antigravity", "Antigravity", "antigravity", "--version"},
		{"ollama", "Ollama", "ollama", "--version"},
		{"git", "Git", "git", "--version"},
		{"go", "Go", "go", "version"},
		{"node", "Node.js", "node", "--version"},
		{"python", "Python", "python", "--version"},
	}

	statuses := make([]CLIStatus, 0, len(targets))
	for _, target := range targets {
		status := CLIStatus{ID: target.id, Label: target.label, Command: target.command}
		path, err := exec.LookPath(target.command)
		if err != nil {
			statuses = append(statuses, status)
			continue
		}

		status.Available = true
		versionCommand := exec.Command(path, target.versionArgument)
		versionCommand.Dir = a.workspacePath()
		output, err := versionCommand.CombinedOutput()
		if err == nil {
			status.Version = strings.TrimSpace(string(output))
			if len(status.Version) > 100 {
				status.Version = status.Version[:100] + "…"
			}
		}
		statuses = append(statuses, status)
	}

	return statuses
}

func (a *App) workspaceTree() (Workspace, error) {
	workspace := a.workspacePath()
	if workspace == "" {
		return Workspace{}, nil
	}

	count := 0
	tree, err := readDirectory(workspace, &count)
	if err != nil {
		return Workspace{}, err
	}
	return Workspace{Path: workspace, Tree: tree}, nil
}

func readDirectory(path string, count *int) ([]FileNode, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}

	nodes := make([]FileNode, 0, len(entries))
	for _, entry := range entries {
		if *count >= maxWorkspaceEntries {
			break
		}
		if entry.IsDir() && ignoredDirectories[entry.Name()] {
			continue
		}

		info, err := entry.Info()
		if err != nil || info.Mode()&fs.ModeSymlink != 0 {
			continue
		}

		*count++
		node := FileNode{Name: entry.Name(), Path: filepath.Join(path, entry.Name()), IsDir: entry.IsDir()}
		if entry.IsDir() {
			node.Children, _ = readDirectory(node.Path, count)
		}
		nodes = append(nodes, node)
	}

	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].IsDir != nodes[j].IsDir {
			return nodes[i].IsDir
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})
	return nodes, nil
}

func (a *App) workspacePath() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.workspace
}

func (a *App) validateWorkspacePath(path string) error {
	workspace := a.workspacePath()
	if workspace == "" {
		return errors.New("open a workspace first")
	}
	if path == "" {
		return errors.New("file path is required")
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(workspace, absPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path must remain inside the active workspace")
	}
	return nil
}

func languageForPath(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx", ".mjs", ".cjs":
		return "javascript"
	case ".json":
		return "json"
	case ".html", ".htm":
		return "html"
	case ".css", ".scss", ".less":
		return "css"
	case ".md", ".mdx":
		return "markdown"
	case ".py":
		return "python"
	case ".rs":
		return "rust"
	case ".yaml", ".yml":
		return "yaml"
	case ".xml":
		return "xml"
	case ".sql":
		return "sql"
	case ".sh", ".ps1", ".bat", ".cmd":
		return "shell"
	default:
		return "plaintext"
	}
}
