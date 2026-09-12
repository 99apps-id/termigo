package mcpserver

import (
	"strings"
	"testing"
)

func TestControlToolRegistry(t *testing.T) {
	for _, name := range []string{
		"termigo_status",
		"termigo_focus",
		"termigo_open",
		"termigo_run",
		"termigo_query",
	} {
		if !isControlTool(name) {
			t.Errorf("expected %q to be a control tool", name)
		}
	}
	if isControlTool("termigo_nope") {
		t.Error("unknown tool should not be a control tool")
	}
}

func TestCallControlToolValidatesArguments(t *testing.T) {
	cases := []struct {
		name string
		args map[string]interface{}
		want string
	}{
		{"termigo_focus", nil, "requires a query"},
		{"termigo_focus", map[string]interface{}{"query": ""}, "requires a query"},
		{"termigo_open", map[string]interface{}{}, "requires a path"},
		{"termigo_run", map[string]interface{}{"prompt": ""}, "requires a prompt"},
		{"termigo_query", nil, "requires a prompt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := callControlTool(tc.name, tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q in error, got: %v", tc.want, err)
			}
		})
	}

	if _, err := callControlTool("bogus", nil); err == nil {
		t.Fatal("expected unknown-tool error")
	}
}
