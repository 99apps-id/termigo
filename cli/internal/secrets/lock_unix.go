//go:build !windows

package secrets

import (
	"os"
	"syscall"
)

// lockFile takes an exclusive advisory lock on the open file, blocking until it
// is free. The kernel releases it when the descriptor closes, so a crashed
// process cannot leave the file locked.
func lockFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX)
}

func unlockFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}
