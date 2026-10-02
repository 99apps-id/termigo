//go:build !windows

package secrets

import (
	"fmt"
	"os"
)

// On POSIX systems the mode bits are the whole access rule, so restricting a
// path is a chmod. The implementation lives behind the same two names as the
// Windows one so the store does not branch on the platform.
func restrictDirectory(path string) error { return os.Chmod(path, 0o700) }

func restrictFile(path string) error { return os.Chmod(path, 0o600) }

func inspect(path string) (FileAccess, error) {
	info, err := os.Stat(path)
	if err != nil {
		return FileAccess{}, fmt.Errorf("stat %s: %w", path, err)
	}
	mode := info.Mode().Perm()
	detail := fmt.Sprintf("mode %04o", mode)
	return FileAccess{
		// Group and other bits must be clear for the file to be private.
		OwnerOnly: mode&0o077 == 0,
		Entries:   []string{detail},
		Detail:    detail,
	}, nil
}
