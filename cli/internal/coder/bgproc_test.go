package coder

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func bgEnv(t *testing.T) *Env {
	t.Helper()
	t.Cleanup(StopBackground)
	return &Env{Workspace: t.TempDir(), Trusted: true}
}

func handleOf(t *testing.T, output string) int {
	t.Helper()
	var id int
	if _, err := fmtSscan(output, &id); err != nil {
		t.Fatalf("no handle in %q", output)
	}
	return id
}

func fmtSscan(output string, id *int) (int, error) {
	const marker = "Started background process "
	rest := output[strings.Index(output, marker)+len(marker):]
	return fmt.Sscanf(rest, "%d", id)
}

func TestBackgroundStartWaitLogsKill(t *testing.T) {
	env := bgEnv(t)
	started, _ := (&runBackgroundTool{}).Run(context.Background(), env, map[string]any{"command": "echo server-ready; sleep 30"})
	if started.IsError {
		t.Fatalf("start: %q", started.Output)
	}
	id := handleOf(t, started.Output)

	waited, _ := (&runWaitTool{}).Run(context.Background(), env, map[string]any{"handle": id, "until": "server-ready", "timeout_secs": 20})
	if !strings.Contains(waited.Output, "the output contains") || !strings.Contains(waited.Output, "server-ready") {
		t.Fatalf("wait: %q", waited.Output)
	}
	if !strings.Contains(waited.Output, "(running)") {
		t.Fatalf("the process should still be running: %q", waited.Output)
	}

	listed, _ := (&runListTool{}).Run(context.Background(), env, nil)
	if !strings.Contains(listed.Output, "running") {
		t.Fatalf("list: %q", listed.Output)
	}

	killed, _ := (&runKillTool{}).Run(context.Background(), env, map[string]any{"handle": id})
	if !strings.Contains(killed.Output, "stopped") {
		t.Fatalf("kill: %q", killed.Output)
	}
}

func TestBackgroundWaitSeesTheExit(t *testing.T) {
	env := bgEnv(t)
	started, _ := (&runBackgroundTool{}).Run(context.Background(), env, map[string]any{"command": "echo done-now"})
	id := handleOf(t, started.Output)
	waited, _ := (&runWaitTool{}).Run(context.Background(), env, map[string]any{"handle": id, "timeout_secs": 20})
	if !strings.Contains(waited.Output, "the process ended") || !strings.Contains(waited.Output, "exited with code 0") || !strings.Contains(waited.Output, "done-now") {
		t.Fatalf("wait: %q", waited.Output)
	}
}

func TestBackgroundUnknownHandleAndOffsets(t *testing.T) {
	env := bgEnv(t)
	if r, _ := (&runLogsTool{}).Run(context.Background(), env, map[string]any{"handle": 9999}); !r.IsError {
		t.Fatal("an unknown handle is an error")
	}
	buf := &bgBuffer{}
	buf.Write([]byte("hello world"))
	text, missed, next := buf.since(6)
	if text != "world" || missed != 0 || next != 11 {
		t.Fatalf("since = %q %d %d", text, missed, next)
	}
	buf.Write([]byte(strings.Repeat("x", bgBufferCap)))
	if _, missed, _ := buf.since(0); missed == 0 {
		t.Fatal("a reader that fell behind is told how much it missed")
	}
}

func TestBackgroundContainsSinceRespectsOffset(t *testing.T) {
	buf := &bgBuffer{}
	buf.Write([]byte("ready-1\n"))
	afterFirst := buf.end()
	if !buf.containsSince(-1, "ready-1") {
		t.Fatal("negative offset should search full buffer")
	}
	if buf.containsSince(afterFirst, "ready-1") {
		t.Fatal("stale output before since offset must not match")
	}
	buf.Write([]byte("ready-2\n"))
	if !buf.containsSince(afterFirst, "ready-2") {
		t.Fatal("output written after since offset should match")
	}
}
