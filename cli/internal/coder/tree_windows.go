//go:build windows

package coder

import (
	"fmt"
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// processTree groups a spawned process with everything it starts, so stopping
// the handle stops the whole tree.
//
// Without this, killing `cmd.exe /c pnpm dev` killed only cmd.exe and left the
// server running: the operator saw "stopped" while the port stayed occupied.
// A job object with kill-on-close is the Windows mechanism for the job.
type processTree struct {
	mu  sync.Mutex
	job windows.Handle
}

func newProcessTree() (*processTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create job object: %w", err)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	)
	if err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("configure job object: %w", err)
	}
	return &processTree{job: job}, nil
}

// prepare runs before the process starts, which is where the POSIX build sets
// a process group. A job object is assigned after start, so there is nothing
// to do here.
//
// This stays as an empty no-op rather than being deleted: the two builds share
// one call site, and a test that reports it as uncovered is showing the
// coverage tool's handling of an empty function body, not dead code.
func (t *processTree) prepare(cmd *exec.Cmd) {}

// attach puts the started process in the job, so its children join too.
//
// A failure is returned rather than fatal: the process is already running, and
// falling back to killing the direct child is worse than nothing but better
// than refusing to start the command at all.
func (t *processTree) attach(cmd *exec.Cmd) error {
	if t.job == 0 || cmd.Process == nil {
		return fmt.Errorf("no job object to attach to")
	}
	handle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		return fmt.Errorf("open process %d: %w", cmd.Process.Pid, err)
	}
	defer windows.CloseHandle(handle)
	if err := windows.AssignProcessToJobObject(t.job, handle); err != nil {
		return fmt.Errorf("assign process %d to job: %w", cmd.Process.Pid, err)
	}
	return nil
}

// terminate kills every process in the job.
func (t *processTree) terminate(cmd *exec.Cmd) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job == 0 {
		return fmt.Errorf("no job object")
	}
	return windows.TerminateJobObject(t.job, 1)
}

// release closes the job handle. Kill-on-close means anything still running in
// the job dies here, which is the last line of defence on shutdown.
func (t *processTree) release() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		windows.CloseHandle(t.job)
		t.job = 0
	}
}
