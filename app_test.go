package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateWorkspacePathRejectsTraversal(t *testing.T) {
	workspace := t.TempDir()
	app := NewApp()
	app.workspace = workspace

	inside := filepath.Join(workspace, "main.go")
	if err := app.validateWorkspacePath(inside); err != nil {
		t.Fatalf("expected file inside workspace to be accepted: %v", err)
	}

	if err := app.validateWorkspacePath(filepath.Join(workspace, "..", "outside.txt")); err == nil {
		t.Fatal("expected path outside workspace to be rejected")
	}
}

func TestReadDirectorySkipsLargeDependencyFolders(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}

	count := 0
	nodes, err := readDirectory(workspace, &count)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].Name != "main.go" {
		t.Fatalf("expected only main.go, got %#v", nodes)
	}
}

func TestLanguageForPath(t *testing.T) {
	if got := languageForPath("editor.tsx"); got != "typescript" {
		t.Fatalf("expected typescript, got %q", got)
	}
	if got := languageForPath("README"); got != "plaintext" {
		t.Fatalf("expected plaintext, got %q", got)
	}
}

func TestTerminalDimensions(t *testing.T) {
	if err := validateTerminalDimensions(120, 32); err != nil {
		t.Fatalf("expected a common terminal size to be accepted: %v", err)
	}
	if err := validateTerminalDimensions(1, 32); err == nil {
		t.Fatal("expected an invalid terminal width to be rejected")
	}
	if err := validateTerminalDimensions(120, 501); err == nil {
		t.Fatal("expected an oversized terminal height to be rejected")
	}
}
