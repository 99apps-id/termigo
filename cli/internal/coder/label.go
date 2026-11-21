package coder

import (
	"strings"
	"sync"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

var (
	labelOnce     sync.Once
	labelRegistry *Registry
)

// ToolLabel is the phrase a front end shows for a tool call ("Reading main.go"),
// or the tool's name when it has no label or its arguments did not parse.
func ToolLabel(call provider.ToolCall) string {
	labelOnce.Do(func() { labelRegistry = DefaultRegistry() })
	tool, ok := labelRegistry.Lookup(call.Name)
	if !ok {
		return call.Name
	}
	args := decodeArgs(call.Arguments)
	if _, bad := args["_repair_error"]; bad {
		return call.Name
	}
	if label := strings.TrimSpace(tool.Label(args)); label != "" {
		return label
	}
	return call.Name
}
