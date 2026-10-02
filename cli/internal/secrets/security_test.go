package secrets

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// TestDirectoryAndFileAreBothRestricted checks the pair, not just the file.
//
// The directory is what carries the inheritance flags on Windows, so a
// restriction that only covered the file would be undone by the next write.
func TestDirectoryAndFileAreBothRestricted(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)

	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := store.Set(ProviderKey("openai"), "sk-test-value"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	fileAccess, err := Inspect(store.Path())
	if err != nil {
		t.Fatalf("Inspect(file): %v", err)
	}
	if !fileAccess.OwnerOnly {
		t.Errorf("secret file is not owner only: %v", fileAccess.Entries)
	}

	dirAccess, err := Inspect(filepath.Dir(store.Path()))
	if err != nil {
		t.Fatalf("Inspect(dir): %v", err)
	}
	if !dirAccess.OwnerOnly {
		t.Errorf("state directory is not owner only: %v", dirAccess.Entries)
	}
}

// TestProtectionSurvivesARepeatedWrite guards the repair path: every save
// re-applies the rules, so a later write must not widen them again.
func TestProtectionSurvivesARepeatedWrite(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)

	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	for index, value := range []string{"sk-one", "sk-two", "sk-three"} {
		if err := store.Set(ProviderKey("openai"), value); err != nil {
			t.Fatalf("Set %d: %v", index, err)
		}
		access, err := Inspect(store.Path())
		if err != nil {
			t.Fatalf("Inspect after write %d: %v", index, err)
		}
		if !access.OwnerOnly {
			t.Fatalf("write %d left the file reachable beyond the owner: %v", index, access.Entries)
		}
	}
	if err := store.ProtectionError(); err != nil {
		t.Errorf("ProtectionError = %v, want nil", err)
	}
}

// TestReloadRepairsALooseFile is the migration guard. A secrets file created
// by an earlier build, or under a wide umask, is tightened on the next read
// instead of staying exposed.
func TestReloadRepairsALooseFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)
	if err := writeLoose(filepath.Join(home, FileName)); err != nil {
		t.Fatalf("create a loose file: %v", err)
	}

	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := store.ProtectionError(); err != nil {
		t.Fatalf("the repair reported a failure: %v", err)
	}
	access, err := Inspect(store.Path())
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if !access.OwnerOnly {
		t.Errorf("a loose file was not repaired: %v", access.Entries)
	}
}

// TestWindowsDoesNotInheritBroadGroups is the specific regression for the bug
// this hardening was written for: on Windows the secret file used to inherit
// the parent directory's grants, so a shared local group could read API keys.
func TestWindowsDoesNotInheritBroadGroups(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the inherited-ACL bug is Windows specific")
	}
	home := t.TempDir()
	t.Setenv(config.EnvHome, home)

	store, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := store.Set(ProviderKey("openai"), "sk-inherit-check"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	access, err := Inspect(store.Path())
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	// Well-known broad trustees: Everyone and BUILTIN\Users. Both are commonly
	// granted read somewhere above a user profile.
	broad := map[string]string{"S-1-1-0": "Everyone", "S-1-5-32-545": "BUILTIN\\Users"}
	for _, entry := range access.Entries {
		if label, bad := broad[entry]; bad {
			t.Errorf("the secret file grants access to %s (%s)", label, entry)
		}
	}
	// A protected DACL with one explicit entry means exactly the owner.
	if len(access.Entries) != 1 {
		t.Errorf("expected exactly one trustee, got %v", access.Entries)
	}
}

// writeLoose creates the secret file world readable, standing in for a file
// written by an older build or under a wide umask. On Windows os.Chmod only
// touches the read-only attribute, so the plain write leaves the file at
// whatever the parent directory grants.
func writeLoose(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
		return err
	}
	return os.Chmod(path, 0o644)
}
