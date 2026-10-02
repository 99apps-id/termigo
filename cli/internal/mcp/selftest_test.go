package mcp_test

// The end-to-end self-test: drive this repo's own MCP server
// (internal/mcpserver) through this repo's own MCP client (internal/mcp) over
// a real stdio subprocess, exactly the way a configured server runs in
// production.
//
// The two packages evolve independently: the client speaks "2024-11-05" and
// decodes rpcResponse shapes, the server answers with its own RPCResponse
// encoding. Nothing else in the tree makes them prove they still agree, so a
// drift landed silently until an actual agent session broke. This test is the
// contract between them.
//
// It lives in an external test package (mcp_test) so it can import mcpserver
// without an import cycle.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/99apps-id/termigo/cli/internal/mcp"
	"github.com/99apps-id/termigo/cli/internal/mcpserver"
)

// TestSelfHelperProcess runs the real MCP server over the subprocess's stdio
// when the test binary is re-invoked by the parent test. It is a Test
// function because the test binary only dispatches -test.run matches.
func TestSelfHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_SELF_HELPER") != "1" {
		return
	}
	workspace := os.Getenv("GO_SELF_WORKSPACE")
	server := mcpserver.New(workspace)
	if err := server.Serve(context.Background(), os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}

// selfServer describes the helper as an MCP server entry.
func selfServer(t *testing.T) mcp.Server {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	return mcp.Server{
		Name:    "self",
		Command: executable,
		Args:    []string{"-test.run=TestSelfHelperProcess"},
		Env: map[string]string{
			"GO_WANT_SELF_HELPER": "1",
			"GO_SELF_WORKSPACE":   t.TempDir(),
		},
	}
}

// TestClientAgainstOwnServer proves the client and the server agree on the
// wire: the handshake succeeds, tools/list carries the server's advertised
// set, and a tools/call round-trips a text result.
func TestClientAgainstOwnServer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := mcp.Connect(ctx, selfServer(t))
	if err != nil {
		t.Fatalf("the client could not complete the handshake with our own server: %v", err)
	}
	defer client.Close()

	tools, err := client.ListTools(ctx)
	if err != nil {
		t.Fatalf("tools/list against our own server failed: %v", err)
	}
	names := make(map[string]bool, len(tools))
	for _, tool := range tools {
		names[tool.Name] = true
	}
	// The control-plane mirrors and the exec surface are what the server
	// advertises unconditionally or by its documented default.
	for _, want := range []string{
		"termigo_pty_exec",
		"termigo_get_diagnostics",
		"termigo_status",
		"termigo_focus",
		"termigo_open",
		"termigo_run",
		"termigo_query",
	} {
		if !names[want] {
			t.Errorf("tools/list is missing %q; the client and server disagree on the tool set (got %v)", want, names)
		}
	}

	// A tools/call to a tool that answers without the running app proves the
	// full request/response round-trip, not just discovery.
	call, err := client.CallTool(ctx, "termigo_pty_exec", map[string]any{"command": "echo selftest"})
	if err != nil {
		t.Fatalf("tools/call round-trip failed: %v", err)
	}
	if call.IsError {
		t.Fatalf("the exec tool reported an error: %q", call.Text)
	}
	if !strings.Contains(call.Text, "selftest") {
		t.Fatalf("the exec output did not echo the command: %q", call.Text)
	}

	if err := client.Ping(ctx); err != nil {
		t.Fatalf("ping after the calls failed: %v", err)
	}
}

// TestClientSeesServerExit proves the client notices the server process
// dying, which is the signal the coder session's reconnect logic depends on.
func TestClientSeesServerExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := mcp.Connect(ctx, selfServer(t))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if client.Dead() {
		t.Fatal("a freshly connected server must not report dead")
	}
	// Killing the process from the client side is what Close does; a plain
	// Close followed by the exit check proves the flag tracks reality.
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Give the wait goroutine a moment to observe the exit.
	deadline := time.Now().Add(5 * time.Second)
	for !client.Dead() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !client.Dead() {
		t.Fatal("the client never reported the server process as dead after Close")
	}
}

// TestServerRejectsUnknownMethodOnTheRealWire proves the error path of the
// protocol also round-trips: an unknown tool is a JSON-RPC error the client
// surfaces as a Go error, not a silent nil.
func TestServerRejectsUnknownMethodOnTheRealWire(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := mcp.Connect(ctx, selfServer(t))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	_, err = client.CallTool(ctx, "no_such_tool", map[string]any{})
	if err == nil {
		t.Fatal("a call to an unknown tool must come back as an error")
	}
	if !strings.Contains(err.Error(), "Unknown tool") {
		t.Fatalf("expected the server's own message, got: %v", err)
	}
}
