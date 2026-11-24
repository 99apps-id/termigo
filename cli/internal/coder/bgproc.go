package coder

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// Background processes outlive a tool call: a dev server or a watcher is
// started once, read and waited on across later steps, and stopped on request.
// They live in the process, not in a session, and StopBackground ends them
// when the program does.

const (
	bgBufferCap   = 256 * 1024
	bgMaxEntries  = 16
	bgDefaultTail = 8000
	bgMaxWait     = 120
)

// bgBuffer keeps the most recent output of a process with a monotonic offset,
// so a reader can ask for "everything since N" and learn how much it missed.
type bgBuffer struct {
	mu   sync.Mutex
	data []byte
	base int
}

func (b *bgBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if over := len(b.data) - bgBufferCap; over > 0 {
		b.data = append([]byte(nil), b.data[over:]...)
		b.base += over
	}
	return len(p), nil
}

// end is the offset one past the last byte written.
func (b *bgBuffer) end() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.base + len(b.data)
}

// since returns the output from offset, how many bytes before it were already
// dropped, and the offset to ask for next. A negative offset means the tail.
func (b *bgBuffer) since(offset int) (text string, missed, next int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	next = b.base + len(b.data)
	if offset < 0 {
		offset = next - bgDefaultTail
	}
	if offset < b.base {
		missed = b.base - offset
		offset = b.base
	}
	if offset > next {
		offset = next
	}
	return string(b.data[offset-b.base:]), missed, next
}

func (b *bgBuffer) contains(text string) bool {
	return b.containsSince(-1, text)
}

// containsSince checks whether buffered output at or after offset contains
// text. A negative offset searches the entire retained buffer.
func (b *bgBuffer) containsSince(offset int, text string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	start := 0
	if offset > b.base {
		start = offset - b.base
		if start > len(b.data) {
			return false
		}
	}
	return strings.Contains(string(b.data[start:]), text)
}

type bgProc struct {
	id      int
	command string
	cwd     string
	started time.Time
	cmd     *exec.Cmd
	tree    *processTree
	buf     *bgBuffer
	done    chan struct{}

	mu       sync.Mutex
	exitCode int
	exited   bool
	killed   bool
}

func (p *bgProc) status() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case !p.exited:
		return "running"
	case p.killed:
		return "stopped"
	default:
		return fmt.Sprintf("exited with code %d", p.exitCode)
	}
}

func (p *bgProc) stop() {
	p.mu.Lock()
	if p.exited {
		p.mu.Unlock()
		return
	}
	p.killed = true
	p.mu.Unlock()
	if p.tree != nil {
		if err := p.tree.terminate(p.cmd); err == nil {
			return
		}
	}
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

type bgRegistry struct {
	mu    sync.Mutex
	next  int
	procs map[int]*bgProc
}

var background = &bgRegistry{next: 1, procs: map[int]*bgProc{}}

// StopBackground ends every process the agent left running. The front ends
// call it on exit so a dev server does not outlive the session.
func StopBackground() {
	background.mu.Lock()
	procs := make([]*bgProc, 0, len(background.procs))
	for _, proc := range background.procs {
		procs = append(procs, proc)
	}
	background.mu.Unlock()
	for _, proc := range procs {
		proc.stop()
	}
}

func (r *bgRegistry) get(args map[string]any) (*bgProc, string) {
	id := argInt(args, "handle", 0, 0, 1<<30)
	r.mu.Lock()
	defer r.mu.Unlock()
	proc, ok := r.procs[id]
	if !ok {
		return nil, fmt.Sprintf("No background process %d. run_list shows the handles in use.", id)
	}
	return proc, ""
}

// start launches the command and registers it. When the table is full the
// oldest finished entry is dropped; if every entry is still running the call
// is refused, so a runaway agent cannot pile up servers.
func (r *bgRegistry) start(env *Env, command, dir string) (*bgProc, error) {
	r.mu.Lock()
	if len(r.procs) >= bgMaxEntries {
		var finished []int
		for id, proc := range r.procs {
			if proc.status() != "running" {
				finished = append(finished, id)
			}
		}
		if len(finished) == 0 {
			r.mu.Unlock()
			return nil, fmt.Errorf("%d background processes are already running; stop one with run_kill first", bgMaxEntries)
		}
		sort.Ints(finished)
		delete(r.procs, finished[0])
	}
	id := r.next
	r.next++
	r.mu.Unlock()

	shell, shellArgs := shellForTool(command)
	cmd := exec.Command(shell, shellArgs...)
	cmd.Dir = dir
	buf := &bgBuffer{}
	cmd.Stdout = buf
	cmd.Stderr = buf
	cmd.WaitDelay = processWaitDelay
	tree, treeErr := newProcessTree()
	if treeErr == nil {
		tree.prepare(cmd)
	}
	if err := cmd.Start(); err != nil {
		if tree != nil {
			tree.release()
		}
		return nil, err
	}
	if tree != nil {
		_ = tree.attach(cmd)
	}
	proc := &bgProc{id: id, command: command, cwd: dir, started: time.Now(), cmd: cmd, tree: tree, buf: buf, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		proc.mu.Lock()
		proc.exited = true
		if cmd.ProcessState != nil {
			proc.exitCode = cmd.ProcessState.ExitCode()
		} else if err != nil {
			proc.exitCode = -1
		}
		proc.mu.Unlock()
		if tree != nil {
			tree.release()
		}
		close(proc.done)
	}()
	r.mu.Lock()
	r.procs[id] = proc
	r.mu.Unlock()
	return proc, nil
}

type runBackgroundTool struct{}

func (t *runBackgroundTool) Name() string      { return "run_background" }
func (t *runBackgroundTool) Aliases() []string { return []string{"bash_background", "start_process"} }
func (t *runBackgroundTool) Mutating() bool    { return true }
func (t *runBackgroundTool) Risk() Risk        { return RiskCommand }
func (t *runBackgroundTool) Label(a map[string]any) string {
	return "Starting " + Shorten(argString(a, "command"), 50)
}
func (t *runBackgroundTool) DoneLabel(a map[string]any) string {
	return "Started " + Shorten(argString(a, "command"), 50)
}
func (t *runBackgroundTool) Description() string {
	return "Start a long-running command (a dev server, a watcher, a slow build) without waiting for it. It returns a handle at once; read the output with run_logs, wait for a ready line or the exit with run_wait, and stop it with run_kill."
}
func (t *runBackgroundTool) Schema() map[string]any {
	return object(map[string]any{
		"command": strProp("Command line to start."),
		"cwd":     strProp("Working directory. Defaults to the workspace root."),
	}, "command")
}

func (t *runBackgroundTool) Run(_ context.Context, env *Env, args map[string]any) (Result, error) {
	command := strings.TrimSpace(argString(args, "command"))
	if command == "" {
		return Result{Output: "command is required", IsError: true}, nil
	}
	dir := resolvePath(env, argString(args, "cwd"))
	if dir == "" {
		dir = env.Workspace
	}
	if err := checkWorkspacePath(env, dir); err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return Result{Output: fmt.Sprintf("working directory %s is not available", dir), IsError: true}, nil
	}
	proc, err := background.start(env, command, dir)
	if err != nil {
		return Result{Output: "Could not start the command: " + err.Error(), IsError: true}, nil
	}
	return Result{Output: fmt.Sprintf("Started background process %d: %s\nRead it with run_logs, wait on it with run_wait, stop it with run_kill.", proc.id, command), Display: fmt.Sprintf("handle %d", proc.id)}, nil
}

type runLogsTool struct{}

func (t *runLogsTool) Name() string      { return "run_logs" }
func (t *runLogsTool) Aliases() []string { return []string{"bash_logs"} }
func (t *runLogsTool) Mutating() bool    { return false }
func (t *runLogsTool) Risk() Risk        { return RiskCommand }
func (t *runLogsTool) Label(a map[string]any) string {
	return "Reading logs of process " + argString(a, "handle")
}
func (t *runLogsTool) DoneLabel(a map[string]any) string {
	return "Read logs of process " + argString(a, "handle")
}
func (t *runLogsTool) Description() string {
	return "Read the output of a background process. Without since it returns the recent tail; pass the next_offset from the last read to get only what is new."
}
func (t *runLogsTool) Schema() map[string]any {
	return object(map[string]any{
		"handle": intProp("Handle returned by run_background."),
		"since":  intProp("Offset to read from, as returned by the previous read."),
	}, "handle")
}

func (t *runLogsTool) Run(_ context.Context, _ *Env, args map[string]any) (Result, error) {
	proc, problem := background.get(args)
	if proc == nil {
		return Result{Output: problem, IsError: true}, nil
	}
	return Result{Output: describeLogs(proc, sinceArg(args))}, nil
}

func sinceArg(args map[string]any) int {
	if _, ok := args["since"]; !ok {
		return -1
	}
	return argInt(args, "since", 0, 0, 1<<40)
}

func describeLogs(proc *bgProc, since int) string {
	text, missed, next := proc.buf.since(since)
	var out strings.Builder
	fmt.Fprintf(&out, "Process %d (%s), next_offset=%d", proc.id, proc.status(), next)
	if missed > 0 {
		fmt.Fprintf(&out, ", %d earlier bytes were dropped", missed)
	}
	out.WriteString("\n")
	if strings.TrimSpace(text) == "" {
		out.WriteString("(no new output)")
	} else {
		out.WriteString(truncateOutput(text, maxOutputChars))
	}
	return out.String()
}

type runWaitTool struct{}

func (t *runWaitTool) Name() string      { return "run_wait" }
func (t *runWaitTool) Aliases() []string { return []string{"bash_wait"} }
func (t *runWaitTool) Mutating() bool    { return false }
func (t *runWaitTool) Risk() Risk        { return RiskCommand }
func (t *runWaitTool) Label(a map[string]any) string {
	return "Waiting for process " + argString(a, "handle")
}
func (t *runWaitTool) DoneLabel(a map[string]any) string {
	return "Waited for process " + argString(a, "handle")
}
func (t *runWaitTool) Description() string {
	return "Wait for a background process to exit, or for its output to contain a text such as a ready message, for up to timeout_secs (at most 120). It returns the output either way, so a timeout is not a failure."
}
func (t *runWaitTool) Schema() map[string]any {
	return object(map[string]any{
		"handle":       intProp("Handle returned by run_background."),
		"until":        strProp("Return as soon as the output contains this text."),
		"timeout_secs": intProp("How long to wait, 1 to 120. Defaults to 30."),
		"since":        intProp("Offset to read output from."),
	}, "handle")
}

func (t *runWaitTool) Run(ctx context.Context, _ *Env, args map[string]any) (Result, error) {
	proc, problem := background.get(args)
	if proc == nil {
		return Result{Output: problem, IsError: true}, nil
	}
	until := argString(args, "until")
	since := sinceArg(args)
	timeout := time.Duration(argInt(args, "timeout_secs", 30, 1, bgMaxWait)) * time.Second
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	reason := "timed out waiting"
wait:
	for {
		if until != "" && proc.buf.containsSince(since, until) {
			reason = "the output contains " + fmt.Sprintf("%q", until)
			break
		}
		select {
		case <-proc.done:
			reason = "the process ended"
			break wait
		case <-deadline.C:
			break wait
		case <-ctx.Done():
			reason = "the run was stopped"
			break wait
		case <-tick.C:
		}
	}
	return Result{Output: reason + "\n" + describeLogs(proc, since)}, nil
}

type runKillTool struct{}

func (t *runKillTool) Name() string      { return "run_kill" }
func (t *runKillTool) Aliases() []string { return []string{"bash_kill", "stop_process"} }
func (t *runKillTool) Mutating() bool    { return false }
func (t *runKillTool) Risk() Risk        { return RiskCommand }
func (t *runKillTool) Label(a map[string]any) string {
	return "Stopping process " + argString(a, "handle")
}
func (t *runKillTool) DoneLabel(a map[string]any) string {
	return "Stopped process " + argString(a, "handle")
}
func (t *runKillTool) Description() string {
	return "Stop a background process started with run_background, together with everything it started."
}
func (t *runKillTool) Schema() map[string]any {
	return object(map[string]any{"handle": intProp("Handle returned by run_background.")}, "handle")
}

func (t *runKillTool) Run(_ context.Context, _ *Env, args map[string]any) (Result, error) {
	proc, problem := background.get(args)
	if proc == nil {
		return Result{Output: problem, IsError: true}, nil
	}
	proc.stop()
	select {
	case <-proc.done:
	case <-time.After(processWaitDelay + 2*time.Second):
	}
	return Result{Output: fmt.Sprintf("Process %d is %s.", proc.id, proc.status())}, nil
}

type runListTool struct{}

func (t *runListTool) Name() string                    { return "run_list" }
func (t *runListTool) Aliases() []string               { return []string{"bash_list"} }
func (t *runListTool) Mutating() bool                  { return false }
func (t *runListTool) Risk() Risk                      { return RiskCommand }
func (t *runListTool) Label(map[string]any) string     { return "Listing background processes" }
func (t *runListTool) DoneLabel(map[string]any) string { return "Listed background processes" }
func (t *runListTool) Description() string {
	return "List the background processes and their state."
}
func (t *runListTool) Schema() map[string]any { return object(map[string]any{}) }

func (t *runListTool) Run(_ context.Context, _ *Env, _ map[string]any) (Result, error) {
	background.mu.Lock()
	ids := make([]int, 0, len(background.procs))
	for id := range background.procs {
		ids = append(ids, id)
	}
	background.mu.Unlock()
	if len(ids) == 0 {
		return Result{Output: "No background processes."}, nil
	}
	sort.Ints(ids)
	var out strings.Builder
	for _, id := range ids {
		background.mu.Lock()
		proc := background.procs[id]
		background.mu.Unlock()
		if proc == nil {
			continue
		}
		fmt.Fprintf(&out, "%d  %s  up %s  %s\n", proc.id, proc.status(), time.Since(proc.started).Round(time.Second), Shorten(proc.command, 60))
	}
	return Result{Output: strings.TrimRight(out.String(), "\n")}, nil
}
