//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTerminalSessionStreamsInteractiveShell(t *testing.T) {
	workspace := t.TempDir()
	session, err := newTerminalSession("test-session", workspace, 120, 32)
	if err != nil {
		t.Fatalf("start terminal session: %v", err)
	}
	defer session.close()

	output := make(chan string, 32)
	exited := make(chan int, 1)
	session.start(
		func(data string) {
			select {
			case output <- data:
			default:
			}
		},
		func(exitCode int) { exited <- exitCode },
	)

	if err := session.resize(100, 40); err != nil {
		t.Fatalf("resize terminal session: %v", err)
	}
	if err := session.write("cd ..\recho %CD%\recho TERMIGO_PTY_OK\r"); err != nil {
		t.Fatalf("write terminal input: %v", err)
	}

	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	var received strings.Builder
	var exitCode *int
	for {
		if strings.Contains(received.String(), "TERMIGO_PTY_OK") {
			break
		}
		select {
		case data := <-output:
			received.WriteString(data)
		case code := <-exited:
			exitCode = &code
		case <-deadline.C:
			if exitCode != nil {
				t.Fatalf("terminal did not stream command output (exit code %d): %q", *exitCode, received.String())
			}
			t.Fatalf("terminal did not stream command output: %q", received.String())
		}
	}

	if err := session.write("exit\r"); err != nil {
		t.Fatalf("stop terminal session: %v", err)
	}
	if exitCode == nil {
		select {
		case code := <-exited:
			exitCode = &code
		case <-time.After(10 * time.Second):
			t.Fatal("terminal did not exit after receiving exit")
		}
	}
	if *exitCode != 0 {
		t.Fatalf("terminal exited with code %d", *exitCode)
	}
	if !strings.Contains(strings.ToLower(received.String()), strings.ToLower(filepath.Dir(workspace))) {
		t.Fatalf("terminal did not retain the changed working directory: %q", received.String())
	}
}
