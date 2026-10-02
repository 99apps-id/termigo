//go:build windows

package secrets

import (
	"os"

	"golang.org/x/sys/windows"
)

// lockFile takes an exclusive lock over the first byte of the file, blocking
// until it is free. The lock lives on the file's handle, so closing it releases
// the lock even if the process exits without unlocking.
func lockFile(file *os.File) error {
	var overlapped windows.Overlapped
	return windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &overlapped)
}

func unlockFile(file *os.File) error {
	var overlapped windows.Overlapped
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &overlapped)
}
