//go:build !windows

package coder

import (
	"fmt"
	"os/exec"
	"syscall"
)

// processTree groups a spawned process with everything it starts, so stopping
// the handle stops the whole tree.
//
// On POSIX the mechanism is a process group: the child is put in its own group
// before it starts, and signalling the negated group id reaches every process
// in it.
type processTree struct{}

func newProcessTree() (*processTree, error) { return &processTree{}, nil }

// prepare puts the child in its own process group, which has to happen before
// it starts.
func (t *processTree) prepare(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func (t *processTree) attach(cmd *exec.Cmd) error { return nil }

// terminate signals the whole group. The negative pid is what makes it a group
// signal rather than a single-process one.
func (t *processTree) terminate(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return fmt.Errorf("no process to terminate")
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

func (t *processTree) release() {}
