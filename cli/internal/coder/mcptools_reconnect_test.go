package coder

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/mcp"
)

// TestDyingHelperProcess is a fake MCP server subprocess. It answers normally
// until it receives a tools/call whose arguments carry "die", at which point
// it exits immediately: that is the crash the session has to recover from.
// It is a Test function (not a plain helper) because the test binary only
// runs it when the subprocess is spawned with -test.run naming it.
func TestDyingHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			continue
		}
		if len(request.ID) == 0 || string(request.ID) == "null" {
			continue
		}
		if request.Method == "tools/call" && request.Params.Arguments["die"] == "true" {
			os.Exit(1)
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": mcp.ProtocolVersion,
				"capabilities":    map[string]any{},
				"serverInfo":      map[string]string{"name": "dying-server", "version": "1.0.0"},
			}
		case "tools/list":
			result = map[string]any{
				"tools": []map[string]any{
					{"name": "echo", "description": "Echo text back"},
				},
			}
		case "tools/call":
			result = map[string]any{
				"content": []map[string]any{{
					"type": "text",
					"text": fmt.Sprintf("called %s", request.Params.Name),
				}},
			}
		default:
			result = map[string]any{}
		}
		_ = encoder.Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  result,
		})
	}
}

func dyingServerCommand(t *testing.T) mcp.Server {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	return mcp.Server{
		Name:    "dying",
		Command: executable,
		Args:    []string{"-test.run=TestDyingHelperProcess"},
		Env:     map[string]string{"GO_WANT_HELPER_PROCESS": "1"},
	}
}

// TestMCPSessionReconnectsAfterTheServerDies is the regression test for the
// dead-tool window: a server process that crashes mid-session used to leave
// its tools erroring until the operator quit. The session must restart the
// process on the next call and answer with it.
func TestMCPSessionReconnectsAfterTheServerDies(t *testing.T) {
	server := dyingServerCommand(t)
	session, tools, ok := connectMCP(context.Background(), server)
	if !ok || len(tools) == 0 {
		t.Fatalf("connectMCP failed to offer tools (ok=%v tools=%d)", ok, len(tools))
	}
	defer session.close()

	// First call works through the original process.
	call, err := session.CallTool(context.Background(), "echo", map[string]any{})
	if err != nil || !strings.Contains(call.Text, "called echo") {
		t.Fatalf("first call = %+v err=%v, want a normal answer", call, err)
	}
	if session.Dead() {
		t.Fatal("the session should be alive after a successful call")
	}

	// This call kills the server process mid-request, so it fails. That
	// failure is expected and is what marks the process dead.
	_, _ = session.CallTool(context.Background(), "echo", map[string]any{"die": "true"})
	if !session.Dead() {
		t.Fatal("the session should report dead after the process exits")
	}

	// The next call must transparently restart the process and answer.
	call, err = session.CallTool(context.Background(), "echo", map[string]any{})
	if err != nil {
		t.Fatalf("call after the server died failed: %v (reconnect did not happen)", err)
	}
	if !strings.Contains(call.Text, "called echo") {
		t.Fatalf("reconnected call = %+v, want the normal answer", call)
	}
	if session.reconns == 0 {
		t.Fatal("the session reports no reconnects; the answer came from somewhere unexpected")
	}
}

// TestMCPSessionStaysUsableThroughTheToolAdapter proves the adapter path the
// model actually drives (mcpTool.Run) survives a server crash too, not just
// the session method underneath it.
func TestMCPSessionStaysUsableThroughTheToolAdapter(t *testing.T) {
	server := dyingServerCommand(t)
	session, tools, ok := connectMCP(context.Background(), server)
	if !ok || len(tools) == 0 {
		t.Fatalf("connectMCP failed to offer tools (ok=%v tools=%d)", ok, len(tools))
	}
	defer session.close()

	tool := tools[0]
	result, err := tool.Run(context.Background(), nil, map[string]any{})
	if err != nil || result.IsError {
		t.Fatalf("first adapter call = %+v err=%v", result, err)
	}

	_, _ = session.CallTool(context.Background(), "echo", map[string]any{"die": "true"})
	if !session.Dead() {
		t.Fatal("the session should report dead after the process exits")
	}

	result, err = tool.Run(context.Background(), nil, map[string]any{})
	if err != nil {
		t.Fatalf("adapter call after the crash failed: %v", err)
	}
	if !strings.Contains(result.Output, "called echo") {
		t.Fatalf("reconnected adapter output = %q", result.Output)
	}
}

// TestConnectMCPReturnsAToolsetAndACloser proves the public entry point still
// returns working tools plus a close function that is safe to call.
func TestConnectMCPReturnsAToolsetAndACloser(t *testing.T) {
	workspace := t.TempDir()
	// No MCP registry in the workspace: the empty result is still a valid
	// (nil, func()) pair that a caller can close.
	tools, closeAll := ConnectMCP(context.Background(), workspace)
	closeAll()
	if len(tools) != 0 {
		t.Fatalf("an empty workspace offered %d tools", len(tools))
	}
}
