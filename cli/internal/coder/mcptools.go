package coder

import (
	"context"
	"strings"

	"github.com/99apps-id/termigo/cli/internal/mcp"
)

// mcpCaller is the slice of *mcp.Client the adapter needs, so a test can stub
// the call without spawning a server process.
type mcpCaller interface {
	CallTool(ctx context.Context, name string, arguments map[string]any) (mcp.Call, error)
}

// mcpTool adapts one MCP server tool to the coder Tool interface. The model
// sees it like any built-in tool; the call is forwarded to the server.
type mcpTool struct {
	client mcpCaller
	server string
	tool   mcp.Tool
	name   string
}

func (t *mcpTool) Name() string { return t.name }

func (t *mcpTool) Aliases() []string { return nil }

func (t *mcpTool) Description() string {
	if strings.TrimSpace(t.tool.Description) != "" {
		return t.tool.Description
	}
	return "MCP tool " + t.tool.Name + " from " + t.server
}

func (t *mcpTool) Schema() map[string]any {
	if t.tool.InputSchema != nil {
		return t.tool.InputSchema
	}
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

// Mutating is true: an MCP tool runs in another process and may change state
// outside the workspace, so it goes through the approval policy.
func (t *mcpTool) Mutating() bool { return true }

func (t *mcpTool) Risk() Risk { return RiskCommand }

func (t *mcpTool) Label(map[string]any) string { return "calls " + t.tool.Name + " on " + t.server }

func (t *mcpTool) DoneLabel(map[string]any) string { return "called " + t.tool.Name }

func (t *mcpTool) Run(ctx context.Context, _ *Env, args map[string]any) (Result, error) {
	call, err := t.client.CallTool(ctx, t.tool.Name, args)
	if err != nil {
		return Result{}, err
	}
	return Result{Output: call.Text, IsError: call.IsError}, nil
}

// ConnectMCP connects every configured MCP server and returns the tools they
// offer, plus a function that closes the clients. A server that fails to start
// is skipped rather than fatal: one broken server must not cost the agent its
// whole tool set.
func ConnectMCP(ctx context.Context, workspace string) ([]Tool, func()) {
	registry, err := mcp.Load(workspace)
	if err != nil {
		return nil, func() {}
	}
	var tools []Tool
	var clients []*mcp.Client
	for _, server := range registry.Servers {
		client, err := mcp.Connect(ctx, server)
		if err != nil {
			continue
		}
		list, err := client.ListTools(ctx)
		if err != nil {
			_ = client.Close()
			continue
		}
		for _, item := range list {
			tools = append(tools, &mcpTool{
				client: client,
				server: server.Name,
				tool:   item,
				name:   mcpToolName(server.Name, item.Name),
			})
		}
		clients = append(clients, client)
	}
	return tools, func() {
		for _, client := range clients {
			_ = client.Close()
		}
	}
}

// mcpToolName qualifies a server tool name with its server and keeps only the
// characters a provider tool name allows, so two servers can offer a tool of
// the same name without colliding and the name is accepted on the wire.
func mcpToolName(server, tool string) string {
	clean := func(value string) string {
		var builder strings.Builder
		for _, r := range strings.ToLower(value) {
			switch {
			case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
				builder.WriteRune(r)
			default:
				builder.WriteByte('_')
			}
		}
		return builder.String()
	}
	name := clean(server) + "__" + clean(tool)
	if len(name) > 128 {
		name = name[:128]
	}
	return name
}
