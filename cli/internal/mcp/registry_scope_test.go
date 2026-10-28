package mcp

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// writeRegistry writes a registry file, creating its directory.
func writeRegistry(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A server name present in both scopes resolves to the project entry, and the
// registry lists it once. Offering it twice produced two identically named
// tools in the agent's toolset, which the provider APIs reject.
func TestLoadProjectScopeOverridesUserScopeForSameName(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	workspace := t.TempDir()

	writeRegistry(t, filepath.Join(workspace, WorkspaceFileName),
		`{"mcpServers":{"dup":{"command":"npx","args":["project"]}}}`)
	writeRegistry(t, filepath.Join(home, "mcp.json"),
		`{"mcpServers":{"dup":{"command":"npx","args":["user"]}}}`)

	registry, err := Load(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Servers) != 1 {
		t.Fatalf("servers = %d, want 1: %+v", len(registry.Servers), registry.Servers)
	}
	server := registry.Servers[0]
	if server.Scope != "project" {
		t.Errorf("scope = %q, want project", server.Scope)
	}
	if len(server.Args) != 1 || server.Args[0] != "project" {
		t.Errorf("args = %v, want [project]", server.Args)
	}
}

// Servers with different names in the two scopes are both kept.
func TestLoadKeepsServersWithDistinctNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	workspace := t.TempDir()

	writeRegistry(t, filepath.Join(workspace, WorkspaceFileName),
		`{"mcpServers":{"proj":{"command":"npx"}}}`)
	writeRegistry(t, filepath.Join(home, "mcp.json"),
		`{"mcpServers":{"usr":{"command":"npx"}}}`)

	registry, err := Load(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Servers) != 2 {
		t.Fatalf("servers = %d, want 2: %+v", len(registry.Servers), registry.Servers)
	}
	if registry.Servers[0].Name != "proj" || registry.Servers[1].Name != "usr" {
		t.Errorf("names = %q, %q; want proj, usr", registry.Servers[0].Name, registry.Servers[1].Name)
	}
}

// A malformed registry is a broken file, not a broken install. The desktop
// app warns and keeps going, so the CLI must not strip the agent of every
// MCP tool it had configured because one registry file got corrupted.
func TestLoadSkipsMalformedRegistry(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	workspace := t.TempDir()

	writeRegistry(t, filepath.Join(workspace, WorkspaceFileName),
		`{"mcpServers":{"good":{"command":"npx"}}}`)
	writeRegistry(t, filepath.Join(home, "mcp.json"), `{ this is not json`)

	registry, err := Load(workspace)
	if err != nil {
		t.Fatalf("Load returned a fatal error for a malformed registry: %v", err)
	}
	if len(registry.Servers) != 1 {
		t.Fatalf("servers = %d, want 1: %+v", len(registry.Servers), registry.Servers)
	}
	if registry.Servers[0].Name != "good" {
		t.Errorf("name = %q, want good", registry.Servers[0].Name)
	}
}

// A server whose command is rejected does not take the other servers down
// with it: the invalid one is skipped and the rest stay usable.
func TestLoadSkipsInvalidServerAndKeepsTheRest(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	workspace := t.TempDir()

	writeRegistry(t, filepath.Join(workspace, WorkspaceFileName),
		`{"mcpServers":{"good":{"command":"npx"},"bad":{"command":"./evil/npx"}}}`)

	registry, err := Load(workspace)
	if err != nil {
		t.Fatalf("Load returned a fatal error for an invalid server: %v", err)
	}
	if len(registry.Servers) != 1 {
		t.Fatalf("servers = %d, want 1: %+v", len(registry.Servers), registry.Servers)
	}
	if registry.Servers[0].Name != "good" {
		t.Errorf("name = %q, want good", registry.Servers[0].Name)
	}
}

// The merged registry stays sorted by name, case-insensitively.
func TestLoadSortsServersByName(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	workspace := t.TempDir()

	writeRegistry(t, filepath.Join(workspace, WorkspaceFileName),
		`{"mcpServers":{"Zebra":{"command":"npx"},"alpha":{"command":"npx"}}}`)

	registry, err := Load(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Servers) != 2 {
		t.Fatalf("servers = %d, want 2", len(registry.Servers))
	}
	if registry.Servers[0].Name != "alpha" || registry.Servers[1].Name != "Zebra" {
		t.Errorf("names = %q, %q; want alpha, Zebra", registry.Servers[0].Name, registry.Servers[1].Name)
	}
}
