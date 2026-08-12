package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadRoundTrip(t *testing.T) {
	home := filepath.Join(t.TempDir(), "termigo-home")
	t.Setenv("TERMIGO_HOME", home)

	config := Config{
		DefaultAgent: "claude",
		Providers: map[string]ProviderOptions{
			"ollama": {Endpoint: "http://localhost:11434", Model: "qwen2.5-coder"},
		},
		MCPServers: map[string]MCPServer{
			"filesystem": {Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-filesystem", "."}},
		},
	}
	if err := Save(config); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.DefaultAgent != "claude" {
		t.Fatalf("DefaultAgent = %q", loaded.DefaultAgent)
	}
	if loaded.Providers["ollama"].Endpoint != "http://localhost:11434" {
		t.Fatalf("ollama endpoint = %q", loaded.Providers["ollama"].Endpoint)
	}
	if loaded.MCPServers["filesystem"].Command != "npx" {
		t.Fatalf("filesystem command = %q", loaded.MCPServers["filesystem"].Command)
	}
}

func TestLoadMissingFileReturnsEmpty(t *testing.T) {
	t.Setenv("TERMIGO_HOME", filepath.Join(t.TempDir(), "nowhere"))
	config, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if config.DefaultAgent != "" || len(config.Providers) != 0 {
		t.Fatalf("expected empty config, got %+v", config)
	}
}

func TestHomeHonoursOverride(t *testing.T) {
	t.Setenv("TERMIGO_HOME", "C:/custom/termigo")
	home, err := Home()
	if err != nil {
		t.Fatalf("Home failed: %v", err)
	}
	if home != "C:/custom/termigo" {
		t.Fatalf("home = %q", home)
	}
}

func TestLoadMalformedJSON(t *testing.T) {
	home := filepath.Join(t.TempDir(), "termigo-home")
	t.Setenv("TERMIGO_HOME", home)
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, FileName), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil {
		t.Fatal("Load accepted malformed JSON")
	}
}
