package mcp

import (
	"os"
	"path/filepath"
	"testing"
)

// A project registry ships inside the repository, so a project-scoped command
// must be a bare allow-listed executable. Anything path-bearing would let a
// repository point the command at a binary it also ships (CVE-2024-22471).
// An unsafe entry is skipped, not fatal: one bad server must not cost the
// operator every other MCP server.
func TestValidateMCPCommandRejectsPathsInProjectScope(t *testing.T) {
	cases := []struct {
		name    string
		command string
	}{
		{"relative path", "./evil/npx"},
		{"parent path", "../evil/npx"},
		{"absolute path", "/usr/bin/npx"},
		{"windows path", `C:\evil\npx.exe`},
		{"backslash path", `evil\npx`},
		{"embedded whitespace", "npx --yes"},
		{"quoted path", `"./evil/npx"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateMCPCommand(tc.command, "project"); err == nil {
				t.Fatalf("expected %q to be rejected in project scope", tc.command)
			}
		})
	}
}

// User scope belongs to the machine owner and stays unrestricted.
func TestValidateMCPCommandAllowsPathsInUserScope(t *testing.T) {
	cases := []string{"/usr/bin/env", "./local/npx", `C:\tools\npx.exe`}
	for _, command := range cases {
		if err := validateMCPCommand(command, "user"); err != nil {
			t.Fatalf("user scope must not be restricted for %q, got %v", command, err)
		}
	}
}

func TestValidateMCPCommandAllowsBareAllowListedNames(t *testing.T) {
	cases := []string{"npx", "uvx", "node", "python3", "node.exe", "python.exe"}
	for _, command := range cases {
		if err := validateMCPCommand(command, "project"); err != nil {
			t.Fatalf("expected %q to be allowed in project scope, got %v", command, err)
		}
	}
}

// The desktop app strips the executable suffix case-sensitively, so `npm.EXE`
// is not an allow-listed name there. The CLI reads the same registry file and
// must reach the same verdict, otherwise the two apps disagree about what a
// project registry is allowed to start.
func TestValidateMCPCommandMatchesDesktopSuffixCaseSensitivity(t *testing.T) {
	if err := validateMCPCommand("npm.EXE", "project"); err == nil {
		t.Fatal("expected an upper-case suffix to be rejected, matching the desktop app")
	}
	if err := validateMCPCommand("npm.exe", "project"); err != nil {
		t.Fatalf("expected a lower-case suffix to be allowed, got %v", err)
	}
}

// Environment overrides in a project registry can repoint the loader or the
// runtime search path, so they must be rejected outside user scope.
func TestValidateMCPEnvRejectsDangerousKeysInProjectScope(t *testing.T) {
	cases := []string{
		"PATH", "path", "PATHEXT",
		"NODE_OPTIONS", "NODE_PATH",
		"PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP",
		"RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB",
		"JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS",
		"CARGO_BUILD_RUSTC_WRAPPER", "RUSTC_WRAPPER",
		"BASH_ENV", "ENV", "NPM_CONFIG_SCRIPT_SHELL",
		"LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
	}
	for _, key := range cases {
		t.Run(key, func(t *testing.T) {
			env := map[string]string{key: "value"}
			if err := validateMCPEnv(env, "project"); err == nil {
				t.Fatalf("expected env %q to be rejected in project scope", key)
			}
			if err := validateMCPEnv(env, "user"); err != nil {
				t.Fatalf("user scope must not be restricted for %q, got %v", key, err)
			}
		})
	}
}

func TestValidateMCPEnvAllowsHarmonicKeysInProjectScope(t *testing.T) {
	env := map[string]string{"GITHUB_TOKEN": "x", "MY_APP_MODE": "dev"}
	if err := validateMCPEnv(env, "project"); err != nil {
		t.Fatalf("expected harmless env to be allowed, got %v", err)
	}
}

// loadFile must skip a project registry entry whose command carries a path,
// because that registry is repository-controlled.
func TestLoadFileSkipsPathBearingCommandInProjectScope(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	content := `{"mcpServers":{"evil":{"command":"./evil/npx","args":["-y","pkg"]}}}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	servers, err := loadFile(path, "project")
	if err != nil {
		t.Fatalf("an unsafe entry must not be fatal, got %v", err)
	}
	if len(servers) != 0 {
		t.Fatalf("expected the unsafe server to be skipped, got %+v", servers)
	}
}

func TestLoadFileSkipsDangerousEnvInProjectScope(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	content := `{"mcpServers":{"evil":{"command":"npx","args":["-y","pkg"],"env":{"LD_PRELOAD":"/tmp/x.so"}}}}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	servers, err := loadFile(path, "project")
	if err != nil {
		t.Fatalf("an unsafe entry must not be fatal, got %v", err)
	}
	if len(servers) != 0 {
		t.Fatalf("expected the unsafe server to be skipped, got %+v", servers)
	}
}

// One unsafe server in a project registry must not take down the safe ones.
func TestLoadFileKeepsSafeServersWhenOneIsUnsafe(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	content := `{"mcpServers":{` +
		`"evil":{"command":"./evil/npx"},` +
		`"good":{"command":"npx","args":["-y","pkg"]}}}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	servers, err := loadFile(path, "project")
	if err != nil {
		t.Fatalf("load must not fail, got %v", err)
	}
	if len(servers) != 1 || servers[0].Name != "good" {
		t.Fatalf("expected only the safe server to survive, got %+v", servers)
	}
}

// The same registries stay usable in user scope, where the machine owner is
// the one who configured them.
func TestLoadFileAllowsPathsAndEnvInUserScope(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	content := `{"mcpServers":{"local":{"command":"./evil/npx","args":["-y","pkg"],"env":{"PATH":"/tmp"}}}}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	servers, err := loadFile(path, "user")
	if err != nil {
		t.Fatalf("user scope must not be restricted, got %v", err)
	}
	if len(servers) != 1 {
		t.Fatalf("expected 1 server, got %d", len(servers))
	}
}
