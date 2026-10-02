package secrets

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrototypePollutionRejected(t *testing.T) {
	home := withTempHome(t)
	path := filepath.Join(home, FileName)
	// Write a secrets.json with well-known prototype pollution keys. Even
	// though Go does not have a prototype chain like JavaScript, accepting
	// these keys is a bug: they must not be loaded into the in-memory store.
	payload := `{
  "provider:openai": "sk-real",
  "__proto__": "polluted",
  "constructor": "polluted",
  "prototype": "polluted"
}
`
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatalf("write secrets: %v", err)
	}
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := store.Get(ProviderKey("openai")); got != "sk-real" {
		t.Errorf("real key = %q, want sk-real", got)
	}
	if got := store.Get("__proto__"); got != "" {
		t.Errorf("__proto__ leaked into store: %q", got)
	}
	if got := store.Get("constructor"); got != "" {
		t.Errorf("constructor leaked into store: %q", got)
	}
	if got := store.Get("prototype"); got != "" {
		t.Errorf("prototype leaked into store: %q", got)
	}
}
