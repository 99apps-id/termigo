package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestRunHelp(t *testing.T) {
	var output bytes.Buffer
	if err := run(nil, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("run returned an error: %v", err)
	}
	if !strings.Contains(output.String(), "Termigo CLI") {
		t.Fatalf("help did not include the CLI name: %q", output.String())
	}
}

func TestRunVersion(t *testing.T) {
	var output bytes.Buffer
	if err := run([]string{"version"}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("run returned an error: %v", err)
	}
	if !strings.Contains(output.String(), "termigo") {
		t.Fatalf("version did not include the executable name: %q", output.String())
	}
}

func TestRunRejectsUnknownCommand(t *testing.T) {
	if err := run([]string{"unknown"}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("run accepted an unknown command")
	}
}

func TestWorkspaceFlagParsing(t *testing.T) {
	workspace, rest, err := workspaceFromArgs([]string{"list", "-w", "C:/work", "--json"})
	if err != nil {
		t.Fatalf("workspaceFromArgs returned an error: %v", err)
	}
	if workspace != "C:/work" {
		t.Fatalf("workspace = %q, want C:/work", workspace)
	}
	if len(rest) != 2 || rest[0] != "list" || rest[1] != "--json" {
		t.Fatalf("rest = %v, want [list --json]", rest)
	}

	workspace, rest, err = workspaceFromArgs([]string{"--workspace=other", "show"})
	if err != nil {
		t.Fatalf("workspaceFromArgs returned an error: %v", err)
	}
	if workspace != "other" || len(rest) != 1 || rest[0] != "show" {
		t.Fatalf("got workspace=%q rest=%v", workspace, rest)
	}
}

func TestTerminalCommandArgumentValidation(t *testing.T) {
	// Each of these is rejected before any control request is made, which is why
	// they pass with no Termigo running: a typo must be a local error, not a
	// connection failure the operator has to interpret.
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"models rejects an unknown option", []string{"models", "--nope"}, "unknown models option"},
		{"models needs a provider id", []string{"models", "--provider"}, "--provider requires an id"},
		{"model rejects an unknown option", []string{"model", "--nope"}, "unknown model option"},
		{"model takes one id", []string{"model", "a", "b"}, "at most one id"},
		{"settings set needs a value", []string{"settings", "set", "defaultModelId"}, "settings set <key> <value>"},
		{"settings rejects a bad boolean", []string{"settings", "set", "toolSearchEnabled", "maybe"}, "true or false"},
		{"settings takes one key", []string{"settings", "a", "b"}, "usage: termigo settings"},
		{"approval rejects an unknown mode", []string{"approval", "never"}, "must be one of"},
		{"approval takes one mode", []string{"approval", "ask", "all"}, "at most one mode"},
		{"secret needs a provider", []string{"secret"}, "usage: termigo secret"},
		{"secret rejects an unknown option", []string{"secret", "-x"}, "unknown secret option"},
		{"tui rejects an argument", []string{"tui", "--nope"}, "unknown tui option"},
		{"setup rejects an argument", []string{"setup", "--nope"}, "unknown setup option"},
		{"endpoint requires subcommand", []string{"endpoint"}, "usage: termigo endpoint"},
		{"endpoint rejects unknown subcommand", []string{"endpoint", "unknown"}, "unknown endpoint subcommand"},
		{"endpoint add requires three arguments", []string{"endpoint", "add", "my-ollama"}, "endpoint add requires"},
		{"endpoint remove requires identifier", []string{"endpoint", "remove"}, "usage: termigo endpoint remove"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := run(tc.args, &bytes.Buffer{}, &bytes.Buffer{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got: %v", tc.want, err)
			}
		})
	}
}

func TestHelpListsTheTerminalCommands(t *testing.T) {
	var output bytes.Buffer
	if err := run([]string{"help"}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("help failed: %v", err)
	}
	for _, want := range []string{"tui", "setup", "models", "model", "settings", "approval", "secret", "endpoint"} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("help should mention %q", want)
		}
	}
}

func TestHelpDoesNotClaimTheCliIgnoresKeys(t *testing.T) {
	// The old help said the CLI never stores API keys. 'secret' does store one,
	// through the app, so keeping that line would be a false statement about
	// where a key goes - the one sentence an operator would rely on.
	var output bytes.Buffer
	if err := run(nil, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("help failed: %v", err)
	}
	if strings.Contains(output.String(), "never stores API keys") {
		t.Fatalf("help still claims the CLI never stores a key: %q", output.String())
	}
	if !strings.Contains(output.String(), "OS keychain") {
		t.Fatalf("help should say where a key does go: %q", output.String())
	}
}

func TestTuiRunsWithScriptedInput(t *testing.T) {
	original := stdin
	stdin = strings.NewReader("q\n")
	t.Cleanup(func() { stdin = original })

	var output bytes.Buffer
	if err := run([]string{"tui"}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("tui failed: %v", err)
	}
	if !strings.Contains(output.String(), "_____ ") {
		t.Fatalf("the TUI should open with the wordmark: %q", output.String())
	}
	if !strings.Contains(output.String(), "Bye.") {
		t.Fatalf("the TUI should acknowledge the quit: %q", output.String())
	}
}

func TestSkillCreateThenList(t *testing.T) {
	workspace := t.TempDir()
	var output bytes.Buffer
	if err := run([]string{"skill", "create", "code-review", "Review pull request diffs", "-w", workspace}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("skill create failed: %v\n%s", err, output.String())
	}
	output.Reset()
	if err := run([]string{"skill", "list", "-w", workspace}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("skill list failed: %v", err)
	}
	if !strings.Contains(output.String(), "code-review") {
		t.Fatalf("skill list did not include created skill: %q", output.String())
	}
	output.Reset()
	if err := run([]string{"skill", "show", "code-review", "-w", workspace}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("skill show failed: %v", err)
	}
	if !strings.Contains(output.String(), "Review pull request diffs") {
		t.Fatalf("skill show did not include the description: %q", output.String())
	}
}

// The MCP commands share one budget per invocation. It has to cover the
// client's own 60s handshake window with room to spare, because an npx-based
// server can spend most of a minute cold-starting; the old 30s ceiling
// cancelled every such call while the client was still correctly waiting.
func TestMCPCommandTimeoutCoversTheHandshake(t *testing.T) {
	if mcpCommandTimeout <= 60*time.Second {
		t.Fatalf("mcpCommandTimeout = %v, which is not longer than the client's 60s handshake window", mcpCommandTimeout)
	}
}

// A context built for one MCP command must start its countdown when the
// command runs, not at process start: a package-level context created in
// init would have burned part of its budget before the command began.
func TestCtxForMCPStartsFreshPerCommand(t *testing.T) {
	first, cancel := ctxForMCP()
	if deadline, ok := first.Deadline(); !ok || time.Until(deadline) < 100*time.Second {
		t.Fatalf("first context deadline = %v ok=%v, want a fresh full window", deadline, ok)
	}
	cancel()
	time.Sleep(10 * time.Millisecond)
	second, cancel := ctxForMCP()
	defer cancel()
	deadline, ok := second.Deadline()
	if !ok {
		t.Fatal("second context has no deadline")
	}
	if remaining := time.Until(deadline); remaining < 100*time.Second {
		t.Fatalf("second context has only %v left, want a fresh window per command", remaining)
	}
}

// The usage text must state the access mode the code actually applies: the
// run defaults to workspace-write, and an operator reading "default:
// read-only" would believe a bare run cannot edit files when it can.
func TestAgentHelpStatesTheRealDefaultAccess(t *testing.T) {
	var output bytes.Buffer
	if err := run([]string{"agent", "help"}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("agent help failed: %v", err)
	}
	if !strings.Contains(output.String(), "default: workspace-write") {
		t.Fatalf("agent help should state the workspace-write default: %q", output.String())
	}
	if strings.Contains(output.String(), "default: read-only") {
		t.Fatalf("agent help still claims read-only is the default: %q", output.String())
	}
}

