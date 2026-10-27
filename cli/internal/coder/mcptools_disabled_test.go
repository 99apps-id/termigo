package coder

import (
	"context"
	"strings"
	"testing"
)

// toolDisabled is an exact-name match: disabling "read" must not hide
// "read_file" from the model.
func TestToolDisabledMatchesExactName(t *testing.T) {
	if !toolDisabled([]string{"read"}, "read") {
		t.Error("read should be disabled")
	}
	if toolDisabled([]string{"read"}, "read_file") {
		t.Error("read_file must stay enabled when only read is disabled")
	}
	if toolDisabled(nil, "read") {
		t.Error("empty list disables nothing")
	}
}

// A disabled tool is rejected before any spawn: the session may predate the
// toggle, so list-time filtering alone is not enough.
func TestDisabledToolCallRejectedWithoutSpawn(t *testing.T) {
	session := &mcpSession{}
	session.server.Name = "github"
	session.server.DisabledTools = []string{"dangerous_tool"}
	_, err := session.call(context.Background(), "dangerous_tool", nil)
	if err == nil || !strings.Contains(err.Error(), "disabled in settings") {
		t.Fatalf("call = no error, want disabled-in-settings refusal, got %v", err)
	}
	if _, err := session.call(context.Background(), "other_tool", nil); err == nil ||
		!strings.Contains(err.Error(), "is unreachable") {
		t.Fatalf("enabled tool should reach the (absent) server, got %v", err)
	}
}
