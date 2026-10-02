package tui

import (
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/secrets"
)

func TestKeyCommandStoresAKey(t *testing.T) {
	t.Setenv(config.EnvHome, t.TempDir())
	store, err := secrets.Load()
	if err != nil {
		t.Fatalf("load secrets: %v", err)
	}
	m := &Model{store: store}

	m.handleKeyCommand([]string{"/key", "deepseek", "sk-test"})
	if got := store.Get(secrets.ProviderKey("deepseek")); got != "sk-test" {
		t.Errorf("stored key = %q, want sk-test", got)
	}

	// An OAuth provider must not accept an API key; it takes a login.
	m.handleKeyCommand([]string{"/key", "muse", "LLM|nope"})
	if got := store.Get(secrets.ProviderKey("muse")); got != "" {
		t.Errorf("an OAuth provider must not store an API key, got %q", got)
	}

	// An unknown provider is reported, not stored.
	m.handleKeyCommand([]string{"/key", "nonesuch", "x"})
}
