//go:build windows

package secrets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TestInspectTreatsANullDACLAsWorldAccessible is the worst case, and the one
// the inspection exists to catch.
//
// A security descriptor with a NULL DACL does not mean "no restrictions were
// recorded"; it means every account is granted full control. Some installers
// and archive tools produce exactly that. Reporting it as anything other than
// a failure would make the doctor line useless for the case it matters most.
func TestInspectTreatsANullDACLAsWorldAccessible(t *testing.T) {
	path := filepath.Join(t.TempDir(), "null-dacl.json")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Pass a nil ACL with DACL_SECURITY_INFORMATION, which is how a NULL DACL
	// is set.
	err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
		nil, nil, nil, nil,
	)
	if err != nil {
		t.Skipf("this filesystem will not accept a NULL DACL: %v", err)
	}

	access, err := inspect(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if access.OwnerOnly {
		t.Fatalf("a NULL DACL grants everyone, so OwnerOnly must be false")
	}
	if !strings.Contains(access.Detail, "world accessible") {
		t.Errorf("detail = %q, want it to name the problem", access.Detail)
	}
}

// TestInspectTreatsAnEmptyDACLAsUnexpected covers the other degenerate case: a
// DACL with no entries denies everyone. That is safe but is never what this
// store writes, so it must not be reported as the expected owner-only state.
//
// An empty ACL cannot be built with ACLFromEntries, which dereferences its
// entry list and panics on an empty one, and InitializeAcl is not exported.
// The header is therefore written directly, which is also the only way such a
// descriptor could reach the store from an outside tool.
func TestInspectTreatsAnEmptyDACLAsUnexpected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty-dacl.json")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	// ACL header: revision, Sbz1, size, AceCount, Sbz2. Zero ACEs.
	buffer := make([]byte, 8)
	buffer[0] = 2 // ACL_REVISION
	buffer[2] = 8
	empty := (*windows.ACL)(unsafe.Pointer(&buffer[0]))
	err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, empty, nil,
	)
	if err != nil {
		t.Skipf("this filesystem will not accept an empty DACL: %v", err)
	}

	access, err := inspect(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if access.OwnerOnly {
		t.Errorf("an empty DACL denies everyone; it is not the owner-only state this store writes")
	}
	if len(access.Entries) != 0 {
		t.Errorf("entries = %v, want none", access.Entries)
	}
}

// TestInspectOnAMissingPathReportsIt keeps a lookup failure from reading as a
// clean verdict, which is what the doctor line depends on.
func TestInspectOnAMissingPathReportsIt(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "not-here.json")
	if _, err := inspect(missing); err == nil {
		t.Errorf("inspecting a missing path must be reported, not assumed safe")
	}
}

// TestRestrictFileThenInspectRoundTrips is the pair the store relies on: what
// restrictFile writes, inspect must read back as owner only.
func TestRestrictFileThenInspectRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "round-trip.json")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	// A loose file first, so the restriction has something to correct.
	if err := applyDACL(path, windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT); err != nil {
		t.Fatalf("applyDACL: %v", err)
	}
	if err := RestrictFile(path); err != nil {
		t.Fatalf("RestrictFile: %v", err)
	}

	access, err := inspect(path)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if !access.OwnerOnly {
		t.Fatalf("the file is reachable beyond the owner: %v", access.Entries)
	}
	if len(access.Entries) != 1 {
		t.Errorf("entries = %v, want exactly the owner", access.Entries)
	}
	// The entry must name this account, not a group it belongs to.
	sid, err := currentUserSID()
	if err != nil {
		t.Fatalf("currentUserSID: %v", err)
	}
	if access.Entries[0] != sid.String() {
		t.Errorf("entry = %q, want the current user %q", access.Entries[0], sid.String())
	}
}

// TestRestrictDirectoryAppliesInheritance is what makes a file created inside
// the state directory private without a second call.
func TestRestrictDirectoryAppliesInheritance(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := restrictDirectory(dir); err != nil {
		t.Fatalf("restrictDirectory: %v", err)
	}
	access, err := inspect(dir)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if !access.OwnerOnly {
		t.Errorf("the directory is reachable beyond the owner: %v", access.Entries)
	}
}
