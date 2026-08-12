package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// TestHelperProcess acts as a fake MCP server when run as a subprocess.
func TestHelperProcess(t *testing.T) {
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
				Name      string `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			continue
		}
		if len(request.ID) == 0 || string(request.ID) == "null" {
			continue // notification
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": ProtocolVersion,
				"capabilities":    map[string]any{},
				"serverInfo":      map[string]string{"name": "fake-server", "version": "1.0.0"},
			}
		case "tools/list":
			result = map[string]any{
				"tools": []map[string]any{
					{"name": "echo", "description": "Echo text back"},
					{"name": "list_files", "description": "List files in a directory"},
				},
			}
		case "tools/call":
			text := fmt.Sprintf("called %s with %v", request.Params.Name, request.Params.Arguments)
			result = map[string]any{
				"content": []map[string]any{{"type": "text", "text": text}},
			}
		case "ping":
			result = map[string]any{}
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

func fakeServerCommand(t *testing.T) Server {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	return Server{
		Name:    "fake",
		Command: executable,
		Args:    []string{"-test.run=TestHelperProcess"},
		Env: map[string]string{
			"GO_WANT_HELPER_PROCESS": "1",
		},
	}
}

func TestConnectListAndCall(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := Connect(ctx, fakeServerCommand(t))
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	defer client.Close()

	tools, err := client.ListTools(ctx)
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	if len(tools) != 2 || tools[0].Name != "echo" {
		t.Fatalf("unexpected tools: %+v", tools)
	}

	call, err := client.CallTool(ctx, "echo", map[string]any{"text": "hello"})
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	if !strings.Contains(call.Text, "called echo") {
		t.Fatalf("unexpected call result: %q", call.Text)
	}

	if err := client.Ping(ctx); err != nil {
		t.Fatalf("Ping failed: %v", err)
	}
}

func TestConnectTimeout(t *testing.T) {
	// A server that never responds must time out rather than hang forever.
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	server := Server{
		Name:    "silent",
		Command: executable,
		Args:    []string{"-test.run=TestSilentHelperProcess"},
		Env:     map[string]string{"GO_WANT_HELPER_PROCESS": "1"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if _, err := Connect(ctx, server); err == nil {
		t.Fatal("Connect to a silent server should time out")
	}
}

// TestSilentHelperProcess reads input and never responds, forcing a timeout.
func TestSilentHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	_, _ = ioCopy(os.Stdin, os.Stdout)
}

func TestRegistryMergeAndEdit(t *testing.T) {
	workspace := t.TempDir()
	project := filepath.Join(workspace, ".termigo", "mcp.json")
	projectJSON := `{
  "mcpServers": {
    "project-server": {
      "command": "npx",
      "args": ["-y", "server-project"]
    }
  }
}`
	if err := os.MkdirAll(filepath.Dir(project), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(project, []byte(projectJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	home := filepath.Join(t.TempDir(), "termigo-home")
	t.Setenv("TERMIGO_HOME", home)
	user := filepath.Join(home, "mcp.json")
	if err := os.MkdirAll(filepath.Dir(user), 0o755); err != nil {
		t.Fatal(err)
	}
	userJSON := `{
  "mcpServers": {
    "user-server": {
      "command": "docker",
      "args": ["run", "--rm", "user-server"]
    }
  }
}`
	if err := os.WriteFile(user, []byte(userJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	registry, err := Load(workspace)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(registry.Servers) != 2 {
		t.Fatalf("loaded %d servers, want 2", len(registry.Servers))
	}
	byName := map[string]Server{}
	for _, server := range registry.Servers {
		byName[server.Name] = server
	}
	if byName["project-server"].Scope != "project" || byName["user-server"].Scope != "user" {
		t.Fatalf("scopes wrong: %+v", byName)
	}

	added, err := Add(workspace, "new-server", config.MCPServer{Command: "python", Args: []string{"server.py"}})
	_ = added
	if err != nil {
		t.Fatalf("Add failed: %v", err)
	}
	registry, err = Load(workspace)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, server := range registry.Servers {
		if server.Name == "new-server" && server.Command == "python" {
			found = true
		}
	}
	if !found {
		t.Fatalf("added server not found: %+v", registry.Servers)
	}

	if err := Remove(workspace, "project-server"); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}
	registry, err = Load(workspace)
	if err != nil {
		t.Fatal(err)
	}
	for _, server := range registry.Servers {
		if server.Name == "project-server" {
			t.Fatal("removed server still present")
		}
	}
}

func TestLoadRejectsServerWithoutCommand(t *testing.T) {
	workspace := t.TempDir()
	project := filepath.Join(workspace, ".termigo", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(project), 0o755); err != nil {
		t.Fatal(err)
	}
	bad := `{"mcpServers": {"broken": {"args": ["x"]}}}`
	if err := os.WriteFile(project, []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(workspace); err == nil {
		t.Fatal("Load accepted a server without a command")
	}
}

func ioCopy(dst *os.File, src *os.File) (int64, error) {
	buffer := make([]byte, 4096)
	var total int64
	for {
		count, err := src.Read(buffer)
		if count > 0 {
			_, _ = dst.Write(buffer[:count])
			total += int64(count)
		}
		if err != nil {
			return total, err
		}
	}
}
