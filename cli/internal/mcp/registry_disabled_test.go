package mcp

import (
	"os"
	"path/filepath"
	"testing"
)

// The desktop app writes disabledTools; the CLI must keep the list through a
// parse so filtering and rejection see the same state.
func TestLoadFileKeepsDisabledTools(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	content := `{"mcpServers":{"fs":{"command":"npx","disabledTools":["dangerous_tool"]}}}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	servers, err := loadFile(path, "user")
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 {
		t.Fatalf("servers = %d, want 1", len(servers))
	}
	if len(servers[0].DisabledTools) != 1 || servers[0].DisabledTools[0] != "dangerous_tool" {
		t.Fatalf("disabled = %v", servers[0].DisabledTools)
	}
}

func TestLoadFileDefaultsDisabledToolsToEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"fs":{"command":"npx"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	servers, err := loadFile(path, "user")
	if err != nil {
		t.Fatal(err)
	}
	if len(servers[0].DisabledTools) != 0 {
		t.Fatalf("disabled = %v, want empty", servers[0].DisabledTools)
	}
}
