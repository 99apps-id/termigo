package mcpserver

import (
	"fmt"

	"github.com/99apps-id/termigo/cli/internal/control"
)

// The MCP mirror of Termigo's control plane, so the MCP server can drive a
// running Termigo the same way the bundled `termigo` CLI does. Descriptor
// discovery, loopback framing and the typed command surface live in
// internal/control, which the CLI's own terminal uses too; this file is only the
// tool layer on top of it.

// controlToolNames are the MCP tools backed by the Termigo control plane.
var controlToolNames = map[string]struct{}{
	"termigo_status": {},
	"termigo_focus":  {},
	"termigo_open":   {},
	"termigo_run":    {},
	"termigo_query":  {},
}

func isControlTool(name string) bool {
	_, ok := controlToolNames[name]
	return ok
}

// callControlTool dispatches a control-plane MCP tool call to the running
// app. Agent-driving calls (run/query) stay approval-gated inside the app.
func callControlTool(name string, args map[string]interface{}) (string, error) {
	arg := func(key string) string {
		s, _ := args[key].(string)
		return s
	}
	switch name {
	case "termigo_status":
		return control.Call(control.MethodStatus, nil, control.ReadTimeout)
	case "termigo_focus":
		query := arg("query")
		if query == "" {
			return "", fmt.Errorf("termigo_focus requires a query")
		}
		return control.Call(control.MethodFocus, map[string]interface{}{"query": query}, control.ReadTimeout)
	case "termigo_open":
		path := arg("path")
		if path == "" {
			return "", fmt.Errorf("termigo_open requires a path")
		}
		return control.Call(control.MethodOpen, map[string]interface{}{"path": path}, control.ReadTimeout)
	case "termigo_run":
		prompt := arg("prompt")
		if prompt == "" {
			return "", fmt.Errorf("termigo_run requires a prompt")
		}
		return control.Call(control.MethodAgentRun, map[string]interface{}{"prompt": prompt}, control.ReadTimeout)
	case "termigo_query":
		prompt := arg("prompt")
		if prompt == "" {
			return "", fmt.Errorf("termigo_query requires a prompt")
		}
		return control.Call(control.MethodQuery, map[string]interface{}{"prompt": prompt}, control.QueryTimeout)
	default:
		return "", fmt.Errorf("unknown control tool %q", name)
	}
}
