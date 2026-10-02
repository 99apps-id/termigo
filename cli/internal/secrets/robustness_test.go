package secrets

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// TestRestrictFileTightensAFileTheStoreDidNotWrite covers the exported helper
// the session store reuses: a conversation can hold a key the user pasted, so
// it needs the same guarantee as the secret file.
func TestRestrictFileTightensAFileTheStoreDidNotWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.json")
	if err := writeLoose(path); err != nil {
		t.Fatalf("write loose file: %v", err)
	}
	if err := RestrictFile(path); err != nil {
		t.Fatalf("RestrictFile: %v", err)
	}
	access, err := Inspect(path)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if !access.OwnerOnly {
		t.Errorf("the file is still reachable beyond the owner: %v", access.Entries)
	}
	// Idempotent: Save calls it on the temporary file and again after the
	// rename, so it must be safe to apply twice.
	if err := RestrictFile(path); err != nil {
		t.Errorf("a second application must succeed: %v", err)
	}
}

func TestRestrictFileReportsAMissingPath(t *testing.T) {
	if err := RestrictFile(filepath.Join(t.TempDir(), "absent.json")); err == nil {
		t.Errorf("restricting a file that is not there must be reported")
	}
}

func TestLoadRejectsAMalformedFile(t *testing.T) {
	home := withTempHome(t)
	if err := os.WriteFile(filepath.Join(home, FileName), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(); err == nil {
		t.Fatalf("a malformed store must be reported, not silently replaced")
	}
}

// TestLoadReportsAnUnreadablePath uses a directory where the file should be.
// That fails on every platform, unlike a permission trick where Windows and
// POSIX disagree about what "unreadable" means.
func TestLoadReportsAnUnreadablePath(t *testing.T) {
	home := withTempHome(t)
	if err := os.MkdirAll(filepath.Join(home, FileName), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := Load(); err == nil {
		t.Fatalf("a directory in place of the store must be reported")
	}
}

// TestLoadRepairsANullBody covers a file containing a bare null, which decodes
// into a nil map. Every later write would panic without the repair.
func TestLoadRepairsANullBody(t *testing.T) {
	home := withTempHome(t)
	if err := os.WriteFile(filepath.Join(home, FileName), []byte("null"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if store.Has(ProviderKey("openai")) {
		t.Errorf("a null body holds no secrets")
	}
	if len(store.Keys()) != 0 {
		t.Errorf("Keys = %v, want none", store.Keys())
	}
	// The important part: writing must work afterwards.
	if err := store.Set(ProviderKey("openai"), "sk-after-null"); err != nil {
		t.Fatalf("Set after a null body: %v", err)
	}
	if got := store.Get(ProviderKey("openai")); got != "sk-after-null" {
		t.Errorf("value = %q", got)
	}
}

// TestSetRollsBackWhenTheWriteFails is the invariant that keeps the in-memory
// view from claiming a secret was stored when the file says otherwise.
func TestSetRollsBackWhenTheWriteFails(t *testing.T) {
	home := withTempHome(t)
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := store.Set(ProviderKey("openai"), "sk-first"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// Replace the state directory with a file so no further write can land.
	if err := os.RemoveAll(home); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := os.WriteFile(home, []byte("in the way"), 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}

	if err := store.Set(ProviderKey("openai"), "sk-second"); err == nil {
		t.Fatalf("a write that cannot be persisted must fail")
	}
	if got := store.Get(ProviderKey("openai")); got != "sk-first" {
		t.Errorf("value = %q, want the previous one after a failed write", got)
	}

	// A key that did not exist before must not survive the failure either, or
	// the app would think a key is configured when nothing was saved.
	if err := store.Set(ProviderKey("anthropic"), "sk-ant"); err == nil {
		t.Fatalf("the write must still fail")
	}
	if store.Has(ProviderKey("anthropic")) {
		t.Errorf("a failed first write left the key in memory")
	}
}

func TestDeleteReportsAWriteFailure(t *testing.T) {
	home := withTempHome(t)
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := store.Set(ProviderKey("openai"), "sk-first"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := os.RemoveAll(home); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := os.WriteFile(home, []byte("in the way"), 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	if err := store.Delete(ProviderKey("openai")); err == nil {
		t.Fatalf("a delete that cannot be persisted must fail")
	}
	// Deletion is not rolled back: losing access to a key is the safe side of
	// a failed delete, and the value is gone from disk on the next success.
	if store.Has(ProviderKey("openai")) {
		t.Errorf("the key should be gone from memory after Delete")
	}
}

func TestStorePathIsInsideTheStateDirectory(t *testing.T) {
	home := withTempHome(t)
	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := filepath.Dir(store.Path()); got != home {
		t.Errorf("store path = %q, want it under %q", store.Path(), home)
	}
	if filepath.Base(store.Path()) != FileName {
		t.Errorf("store file = %q, want %q", filepath.Base(store.Path()), FileName)
	}
	if err := store.ProtectionError(); err != nil {
		t.Errorf("a fresh store should have no protection error: %v", err)
	}
}

// TestWriteUnderAnUnusableStateDirectoryIsReported points the override at a
// path whose parent is a file. Whether the read fails or reports "absent"
// differs by platform, so the assertion is on the write, which must always
// fail rather than pretend the secret was stored.
func TestWriteUnderAnUnusableStateDirectoryIsReported(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Setenv(config.EnvHome, filepath.Join(blocker, "state"))

	store, err := Load()
	if err != nil {
		return
	}
	if err := store.Set(ProviderKey("openai"), "sk-unreachable"); err == nil {
		t.Fatalf("writing under a file must fail")
	}
	if store.Has(ProviderKey("openai")) {
		t.Errorf("a failed write must not leave the key in memory")
	}
}
