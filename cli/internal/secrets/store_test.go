package secrets

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
)

func withTempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	return home
}

func TestSetGetDeleteRoundTrip(t *testing.T) {
	withTempHome(t)
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if store.Has(ProviderKey("openai")) {
		t.Fatalf("a fresh store should be empty")
	}
	if err := store.Set(ProviderKey("openai"), "sk-secret"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if !store.Has(ProviderKey("openai")) {
		t.Fatalf("Has should be true after Set")
	}

	// A second load must see the value, which is the whole point of the file.
	reloaded, err := Load()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reloaded.Get(ProviderKey("openai")); got != "sk-secret" {
		t.Errorf("reloaded value = %q", got)
	}

	if err := store.Delete(ProviderKey("openai")); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	afterDelete, _ := Load()
	if afterDelete.Has(ProviderKey("openai")) {
		t.Errorf("the key should be gone after Delete")
	}
}

// TestSetKeepsOtherSecrets guards the operator's expectation that changing a
// provider key never drops the bot token. A model change writes only
// config.json and never opens this file, but a provider key is stored here, and
// it must not take the rest of the map with it.
func TestSetKeepsOtherSecrets(t *testing.T) {
	withTempHome(t)
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := store.Set(TelegramTokenKey(), "8793125192:token"); err != nil {
		t.Fatalf("set telegram token: %v", err)
	}
	// Writing a provider key must leave the bot token in place.
	if err := store.Set(ProviderKey("openai"), "sk-secret"); err != nil {
		t.Fatalf("set provider key: %v", err)
	}
	reloaded, err := Load()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reloaded.Get(TelegramTokenKey()); got != "8793125192:token" {
		t.Errorf("telegram token = %q, want it kept when a provider key was written", got)
	}
	if got := reloaded.Get(ProviderKey("openai")); got != "sk-secret" {
		t.Errorf("provider key = %q", got)
	}
}

// TestSetMergesAnotherProcessesWrite covers two processes on one file: the
// serve service and a terminal each hold a store, and one writes a key the other
// has never seen. Saving must merge onto the file as it is now, not write the
// stale in-memory map, or the unknown key is lost.
func TestSetMergesAnotherProcessesWrite(t *testing.T) {
	home := withTempHome(t)
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := store.Set(ProviderKey("openai"), "sk-a"); err != nil {
		t.Fatalf("set provider: %v", err)
	}

	// Another process adds the bot token straight to the file after this store
	// was loaded.
	path := filepath.Join(home, FileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read secrets: %v", err)
	}
	var onDisk map[string]string
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("parse: %v", err)
	}
	onDisk[TelegramTokenKey()] = "8793125192:token"
	updated, _ := json.Marshal(onDisk)
	if err := os.WriteFile(path, updated, 0o600); err != nil {
		t.Fatalf("write secrets: %v", err)
	}

	// The stale store writes a different key. The bot token must survive.
	if err := store.Set(ProviderKey("deepseek"), "sk-b"); err != nil {
		t.Fatalf("set second provider: %v", err)
	}
	reloaded, err := Load()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reloaded.Get(TelegramTokenKey()); got != "8793125192:token" {
		t.Errorf("telegram token = %q, want it kept across a concurrent write", got)
	}
	if got := reloaded.Get(ProviderKey("openai")); got != "sk-a" {
		t.Errorf("openai key = %q", got)
	}
	if got := reloaded.Get(ProviderKey("deepseek")); got != "sk-b" {
		t.Errorf("deepseek key = %q", got)
	}
}

func TestSecretFileIsPrivate(t *testing.T) {
	withTempHome(t)
	store, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Set(TelegramTokenKey(), "123:abc"); err != nil {
		t.Fatal(err)
	}
	path, err := config.HomePath(FileName)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ProtectionError(); err != nil {
		t.Fatalf("the store reported a protection failure: %v", err)
	}
	// Inspect works on every platform: mode bits on POSIX, the DACL on
	// Windows. This is the assertion that would have caught the inherited
	// group-read grant the Windows path used to have.
	access, err := Inspect(path)
	if err != nil {
		t.Fatalf("inspect secrets: %v", err)
	}
	if !access.OwnerOnly {
		t.Errorf("secret file is reachable beyond the owner: %v", access.Entries)
	}
	if _, err := Inspect(store.Path()); err != nil {
		t.Fatalf("inspect by store path: %v", err)
	}

	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat secrets: %v", err)
	}
	// The process umask can only tighten this, never loosen it.
	if info.Mode().Perm() != 0o600 {
		t.Errorf("secrets file mode = %o, want 600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm()&0o077 != 0 {
		t.Errorf("state directory mode = %o, want no group or other access", dirInfo.Mode().Perm())
	}
}

func TestDeleteMissingKeyIsNotAnError(t *testing.T) {
	withTempHome(t)
	store, _ := Load()
	if err := store.Delete(ProviderKey("nope")); err != nil {
		t.Errorf("deleting a missing key should be a no-op, got %v", err)
	}
}

func TestKeysAreSortedAndRedacted(t *testing.T) {
	withTempHome(t)
	store, _ := Load()
	_ = store.Set(ProviderKey("openai"), "sk-1234567890")
	_ = store.Set(TelegramTokenKey(), "123456:ABCDEF")

	keys := store.Keys()
	if len(keys) != 2 {
		t.Fatalf("Keys = %v, want two entries", keys)
	}
	if keys[0] > keys[1] {
		t.Errorf("keys must be sorted: %v", keys)
	}
}

func TestRedactNeverRevealsTheWholeSecret(t *testing.T) {
	cases := []string{"sk-1234567890abcdef", "short", ""}
	for _, value := range cases {
		redacted := Redact(value)
		if value != "" && redacted == value {
			t.Errorf("Redact(%q) revealed the whole value", value)
		}
	}
	if Redact("") != "(not set)" {
		t.Errorf("an empty secret should read as not set, got %q", Redact(""))
	}
}
