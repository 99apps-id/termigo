package mcpserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestDetectLintCommand(t *testing.T) {
	t.Run("package.json with lint script uses the package manager", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, dir, "package.json", `{"packageManager":"pnpm@9.15.9","scripts":{"lint":"biome lint ./src"}}`)
		writeFile(t, dir, "pnpm-lock.yaml", "")

		cmd, note := detectLintCommand(dir)
		if cmd != "pnpm run lint" {
			t.Errorf("expected pnpm run lint, got %q", cmd)
		}
		if !strings.Contains(note, "package.json") {
			t.Errorf("expected package.json note, got %q", note)
		}
	})

	t.Run("package.json without lint script falls through", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, dir, "package.json", `{"scripts":{"build":"vite build"}}`)
		writeFile(t, dir, "go.mod", "module example.com/x")

		cmd, _ := detectLintCommand(dir)
		if cmd != "go vet ./..." {
			t.Errorf("expected go vet fallback, got %q", cmd)
		}
	})

	t.Run("cargo workspace picks clippy", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, dir, "Cargo.toml", "[package]")

		cmd, _ := detectLintCommand(dir)
		if !strings.HasPrefix(cmd, "cargo clippy") {
			t.Errorf("expected cargo clippy, got %q", cmd)
		}
	})

	t.Run("empty workspace reports no linter", func(t *testing.T) {
		dir := t.TempDir()
		cmd, note := detectLintCommand(dir)
		if cmd != "" {
			t.Errorf("expected empty command, got %q", cmd)
		}
		if !strings.Contains(note, "could not detect") {
			t.Errorf("expected detection failure note, got %q", note)
		}
	})
}

func TestPackageManagerFor(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "yarn.lock", "")

	pm := packageManagerFor(dir, []byte(`{"packageManager":"yarn@4.0.0"}`))
	if pm != "yarn" {
		t.Errorf("expected yarn from packageManager field, got %q", pm)
	}

	pm = packageManagerFor(dir, []byte(`{}`))
	if pm != "yarn" {
		t.Errorf("expected yarn from lockfile, got %q", pm)
	}

	empty := t.TempDir()
	pm = packageManagerFor(empty, []byte(`{}`))
	if pm != "npm" {
		t.Errorf("expected npm default, got %q", pm)
	}
}

func TestRunDiagnosticsNoLinter(t *testing.T) {
	dir := t.TempDir()
	srv := New(dir)

	text := srv.runDiagnostics(context.Background(), "")
	if !strings.Contains(text, "No diagnostics available") {
		t.Errorf("expected no-diagnostics message, got %q", text)
	}
}
