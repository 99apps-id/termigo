package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const diagnosticsTimeout = 120 * time.Second

// detectLintCommand picks a lint/check command for the workspace by inspecting
// its manifests, mirroring the frontend's detectCheckCommand(kind="lint").
// It returns the command and a short note describing what matched.
func detectLintCommand(workspace string) (string, string) {
	if raw, err := os.ReadFile(filepath.Join(workspace, "package.json")); err == nil {
		if script := lintScript(raw); script != "" {
			pm := packageManagerFor(workspace, raw)
			return fmt.Sprintf("%s run lint", pm), "package.json lint script"
		}
	}
	if fileExists(workspace, "Cargo.toml") {
		return "cargo clippy --all-targets -- -D warnings", "Cargo.toml (clippy)"
	}
	if fileExists(workspace, "go.mod") {
		return "go vet ./...", "go.mod"
	}
	if fileExists(workspace, "pyproject.toml") {
		return "ruff check .", "pyproject.toml (ruff)"
	}
	return "", "could not detect a linter from package.json, Cargo.toml, go.mod or pyproject.toml"
}

// lintScript extracts the `lint` script from a package.json body, if present.
func lintScript(pkgJSON []byte) string {
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(pkgJSON, &pkg); err != nil {
		return ""
	}
	return strings.TrimSpace(pkg.Scripts["lint"])
}

// packageManagerFor infers the package manager from the packageManager field,
// then lockfiles, defaulting to npm.
func packageManagerFor(workspace string, pkgJSON []byte) string {
	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(pkgJSON, &pkg); err == nil && pkg.PackageManager != "" {
		// "pnpm@9.15.9" -> "pnpm"
		if idx := strings.Index(pkg.PackageManager, "@"); idx > 0 {
			return pkg.PackageManager[:idx]
		}
		return pkg.PackageManager
	}
	switch {
	case fileExists(workspace, "pnpm-lock.yaml"):
		return "pnpm"
	case fileExists(workspace, "yarn.lock"):
		return "yarn"
	case fileExists(workspace, "bun.lockb"), fileExists(workspace, "bun.lock"):
		return "bun"
	default:
		return "npm"
	}
}

func fileExists(workspace, name string) bool {
	_, err := os.Stat(filepath.Join(workspace, name))
	return err == nil
}

// runDiagnostics executes the detected lint command in the workspace and
// returns its combined output. An optional path narrows a file-scoped lint.
func (s *Server) runDiagnostics(ctx context.Context, path string) string {
	command, note := detectLintCommand(s.workspace)
	if command == "" {
		return fmt.Sprintf("No diagnostics available: %s.", note)
	}

	// Narrow to a single file when the linter supports file arguments and a path
	// was supplied. Only do this for runners that accept a trailing path.
	if path != "" && strings.HasPrefix(command, "ruff check") {
		command = fmt.Sprintf("ruff check %s", path)
	}

	cmdCtx, cancel := context.WithTimeout(ctx, diagnosticsTimeout)
	defer cancel()

	var cmd *exec.Cmd
	if isWindows() {
		cmd = exec.CommandContext(cmdCtx, "powershell", "-Command", command)
	} else {
		cmd = exec.CommandContext(cmdCtx, "sh", "-c", command)
	}
	cmd.Dir = s.workspace

	outBytes, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(outBytes))

	if cmdCtx.Err() == context.DeadlineExceeded {
		return fmt.Sprintf("Diagnostics command timed out after %s:\n%s", diagnosticsTimeout, output)
	}

	if output == "" {
		if err != nil {
			return fmt.Sprintf("Diagnostics command failed (%v) with no output.", err)
		}
		return "No active diagnostic issues found."
	}

	// A non-zero exit here usually means the linter found issues, which is the
	// point of the tool, so surface the output rather than treating it as an
	// execution error.
	return output
}

func isWindows() bool {
	return strings.Contains(strings.ToLower(os.Getenv("OS")), "windows")
}
