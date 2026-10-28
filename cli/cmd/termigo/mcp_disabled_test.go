package main

import (
	"strings"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/mcp"
)

// mcpToolDisabled is an exact-name match: disabling "read" must not disable
// "read_file", and an empty list disables nothing.
func TestMcpToolDisabledMatchesExactName(t *testing.T) {
	if !mcpToolDisabled([]string{"read"}, "read") {
		t.Error("read should be disabled")
	}
	if mcpToolDisabled([]string{"read"}, "read_file") {
		t.Error("read_file must stay enabled when only read is disabled")
	}
	if mcpToolDisabled(nil, "read") {
		t.Error("empty list disables nothing")
	}
}

// `termigo mcp call` must refuse a tool the desktop app disabled, without
// contacting the server. The registry is shared between the two, so the CLI
// has to honour the same list the app enforces.
func TestCallMCPToolRefusesDisabledTool(t *testing.T) {
	server := mcp.Server{
		Name:          "github",
		Command:       "definitely-not-a-real-command",
		DisabledTools: []string{"dangerous_tool"},
	}
	var output strings.Builder
	err := callMCPToolWithServer(t.Context(), server, "dangerous_tool", map[string]any{}, &output)
	if err == nil {
		t.Fatal("call succeeded, want a disabled-in-settings refusal")
	}
	if !strings.Contains(err.Error(), "disabled in settings") {
		t.Fatalf("error = %v, want a disabled-in-settings refusal", err)
	}
}

// An enabled tool on a server that cannot start still fails at the connection
// step, which proves the disabled check did not reject it.
func TestCallMCPToolAllowsEnabledTool(t *testing.T) {
	server := mcp.Server{
		Name:          "github",
		Command:       "definitely-not-a-real-command",
		DisabledTools: []string{"dangerous_tool"},
	}
	var output strings.Builder
	err := callMCPToolWithServer(t.Context(), server, "safe_tool", map[string]any{}, &output)
	if err == nil {
		t.Fatal("call succeeded, want the connection to fail")
	}
	if strings.Contains(err.Error(), "disabled in settings") {
		t.Fatalf("error = %v, want a connection failure rather than a disabled refusal", err)
	}
}
