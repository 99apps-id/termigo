package coder

import (
	"context"
	"strings"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/mcp"
)

type stubMCP struct{ out mcp.Call }

func (s stubMCP) CallTool(context.Context, string, map[string]any) (mcp.Call, error) {
	return s.out, nil
}

func TestMCPToolAdaptsACall(t *testing.T) {
	tool := &mcpTool{
		client: stubMCP{out: mcp.Call{Text: "result"}},
		server: "github",
		tool:   mcp.Tool{Name: "search", Description: "find things"},
		name:   mcpToolName("github", "search"),
	}
	if tool.Name() != "github__search" {
		t.Errorf("name = %q", tool.Name())
	}
	if !tool.Mutating() {
		t.Error("an MCP tool must go through approval")
	}
	if tool.Description() != "find things" {
		t.Errorf("description = %q", tool.Description())
	}
	if schema := tool.Schema(); schema["type"] != "object" {
		t.Errorf("default schema = %v", schema)
	}
	result, err := tool.Run(context.Background(), nil, map[string]any{"q": "x"})
	if err != nil || result.Output != "result" || result.IsError {
		t.Fatalf("run = %+v err=%v", result, err)
	}
}

func TestMCPToolNameIsQualifiedAndSafe(t *testing.T) {
	got := mcpToolName("My Server!", "List Files")
	if !strings.HasPrefix(got, "my_server_") || !strings.Contains(got, "__") {
		t.Errorf("name = %q, want the server prefix and a __ separator", got)
	}
	for _, r := range got {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
		if !ok {
			t.Fatalf("unsafe character %q in %q", r, got)
		}
	}
}
