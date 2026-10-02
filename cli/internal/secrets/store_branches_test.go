package secrets

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// TestSaveReportsAnUnwritablePath covers the write itself failing after the
// directory was prepared. Getting this wrong would mean a Set that reports
// success while nothing reached the disk.
func TestSaveReportsAnUnwritablePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	path := filepath.Join(home, FileName)

	// A directory where the temporary file belongs makes the write fail. The
	// state directory and its access rules are fine, so this isolates the
	// write step.
	if err := os.MkdirAll(path+".tmp", 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	store := &Store{path: path, data: map[string]string{}}
	err := store.Set(ProviderKey("openai"), "sk-unwritable")
	if err == nil {
		t.Fatalf("a write that cannot land must fail")
	}
	if store.Has(ProviderKey("openai")) {
		t.Errorf("a failed write must not leave the key in memory")
	}
	if _, statErr := os.Stat(path); statErr == nil {
		t.Errorf("no secret file should have been created")
	}
}

// TestSaveReportsAnUnprotectableDirectory covers the step that gives the
// directory its access rules. It runs before the file exists, so a failure
// here must stop the write rather than create a file with inherited grants.
func TestSaveReportsAnUnprotectableDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)

	// The store's directory is a path whose parent is a file, so the directory
	// cannot be created at all.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	store := &Store{path: filepath.Join(blocker, "state", FileName), data: map[string]string{}}
	if err := store.Set(ProviderKey("openai"), "sk-blocked"); err == nil {
		t.Fatalf("an unusable state directory must fail the write")
	}
}

// TestDeleteOnAFreshStoreIsANoOp pins that removing nothing is not an error,
// which is what lets the unpair path run unconditionally.
func TestDeleteOnAFreshStoreIsANoOp(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)

	store := &Store{path: filepath.Join(home, FileName), data: map[string]string{}}
	if err := store.Delete(ProviderKey("openai")); err != nil {
		t.Fatalf("deleting a missing key must be a no-op: %v", err)
	}
	// The file must not be created just to record the absence.
	if _, err := os.Stat(store.path); err == nil {
		t.Errorf("a no-op delete should not write the file")
	}
}

// TestKeysAndHasAgreeOnABlankValue keeps an empty string from counting as a
// stored secret, which is what makes Has the honest question.
func TestKeysAndHasAgreeOnABlankValue(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)

	store := &Store{path: filepath.Join(home, FileName), data: map[string]string{
		"provider:openai": "",
		"provider:groq":   "   ",
	}}
	// A blank value is present in the map but is not a usable key.
	if store.Get("provider:openai") != "" {
		t.Errorf("Get should return the stored blank")
	}
	if store.Has("provider:openai") || store.Has("provider:groq") {
		t.Errorf("a blank value must not count as a stored secret")
	}
	if len(store.Keys()) != 2 {
		t.Errorf("Keys = %v, want both entries listed", store.Keys())
	}
}
