package coder

import (
	"testing"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

func TestToolLabelNamesWhatTheCallDoes(t *testing.T) {
	got := ToolLabel(provider.ToolCall{Name: "read_file", Arguments: `{"path":"internal/api/orders.go"}`})
	if got == "read_file" || got == "" {
		t.Fatalf("a known tool should read as a phrase, got %q", got)
	}
}

func TestToolLabelFallsBackToTheName(t *testing.T) {
	for _, call := range []provider.ToolCall{
		{Name: "mcp_unknown_tool", Arguments: `{"a":1}`},
		{Name: "read_file", Arguments: `{not json`},
	} {
		if got := ToolLabel(call); got != call.Name {
			t.Fatalf("ToolLabel(%+v) = %q, want the name", call, got)
		}
	}
}
