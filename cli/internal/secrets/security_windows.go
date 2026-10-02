//go:build windows

package secrets

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// On Windows os.Chmod only toggles the read-only attribute, so a secrets file
// written there inherited whatever the parent directory granted. On a machine
// with a shared local group that meant other accounts could read API keys.
// These functions set an explicit DACL instead.

// restrictDirectory grants the current user full control and stops the parent
// directory's grants being inherited. The inheritance flags are what make
// every file created inside pick up the same restriction.
func restrictDirectory(path string) error {
	return applyDACL(path, windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT)
}

// restrictFile grants the current user full control of one file.
func restrictFile(path string) error {
	return applyDACL(path, windows.NO_INHERITANCE)
}

func applyDACL(path string, inheritance uint32) error {
	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	entries := []windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.ACCESS_MASK(windows.GENERIC_ALL),
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       inheritance,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}}
	acl, err := windows.ACLFromEntries(entries, nil)
	if err != nil {
		return fmt.Errorf("build acl for %s: %w", path, err)
	}
	// PROTECTED_DACL is the part os.Chmod cannot express: it discards the
	// inherited entries, so the explicit single-user ACL is the whole story.
	err = windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, acl, nil,
	)
	if err != nil {
		return fmt.Errorf("restrict %s: %w", path, err)
	}
	return nil
}

// currentUserSID identifies the account the process runs as.
func currentUserSID() (*windows.SID, error) {
	// GetCurrentProcessToken returns a pseudo token carrying TOKEN_QUERY. It
	// must not be closed, which is why it is preferred over the deprecated
	// OpenCurrentProcessToken, whose real handle has to be released.
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("read the process token user: %w", err)
	}
	return user.User.Sid, nil
}

func inspect(path string) (FileAccess, error) {
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return FileAccess{}, fmt.Errorf("read acl of %s: %w", path, err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return FileAccess{}, fmt.Errorf("read dacl of %s: %w", path, err)
	}
	if dacl == nil {
		// A nil DACL grants everyone full control, which is the worst case
		// rather than a missing answer.
		return FileAccess{OwnerOnly: false, Detail: "no DACL (world accessible)"}, nil
	}
	owner, err := currentUserSID()
	if err != nil {
		return FileAccess{}, err
	}
	ownerKey := owner.String()

	access := FileAccess{OwnerOnly: true, Detail: fmt.Sprintf("%d entries", dacl.AceCount)}
	for index := uint16(0); index < dacl.AceCount; index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, uint32(index), &ace); err != nil {
			return FileAccess{}, fmt.Errorf("read ace %d of %s: %w", index, path, err)
		}
		if ace == nil {
			continue
		}
		// ACCESS_ALLOWED_ACE exposes the SID as its first inline field
		// rather than through a method, so this is the documented way to
		// read it.
		name := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		access.Entries = append(access.Entries, name)
		if name != ownerKey {
			access.OwnerOnly = false
		}
	}
	if len(access.Entries) == 0 {
		// An empty DACL denies everyone, which is safe but never what this
		// store writes, so treat it as unexpected.
		access.OwnerOnly = false
	}
	return access, nil
}
