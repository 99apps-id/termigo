package coder

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/99apps-id/termigo/cli/internal/mcp"
)

// mcpCaller is the slice of *mcp.Client the adapter needs, so a test can stub
// the call without spawning a server process.
type mcpCaller interface {
	CallTool(ctx context.Context, name string, arguments map[string]any) (mcp.Call, error)
	// Dead reports whether the connection behind the caller is gone, which is
	// what tells the session a reconnect is worth trying before the next call.
	Dead() bool
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

// mcpSession holds one MCP server connection for the lifetime of the agent
// session and re-establishes it when the server process dies.
//
// The old design pinned a client at startup: a server that crashed an hour
// into a session left its tools erroring until the operator quit, because
// nothing ever restarted the process. This session instead reconnects lazily:
// the first call after a death spawns a fresh process, and the tool set the
// model was offered stays frozen so the conversation (and the provider's
// prompt cache) is not invalidated mid-run by a changed tools/list.
type mcpSession struct {
	mu      sync.Mutex
	server  mcp.Server
	client  *mcp.Client
	reconns int
}

// mcpMaxReconnectsPerCall bounds how many restarts one tool call may drive.
// Reconnect is lazy, so a server that dies in a tight loop must not turn one
// call into an unbounded spawn loop.
const mcpMaxReconnectsPerCall = 2

// call runs one tool invocation, reconnecting once when the process is gone.
func (s *mcpSession) call(ctx context.Context, name string, arguments map[string]any) (mcp.Call, error) {
	var lastErr error
	for attempt := 0; attempt <= mcpMaxReconnectsPerCall; attempt++ {
		s.mu.Lock()
		client := s.client
		dead := client == nil || client.Dead()
		s.mu.Unlock()

		if dead {
			reconnected, err := s.reconnect(ctx)
			if err != nil {
				lastErr = err
				continue
			}
			client = reconnected
		}

		call, err := client.CallTool(ctx, name, arguments)
		if err == nil {
			return call, nil
		}
		lastErr = err
		// A call can fail with the process dying underneath it; only a dead
		// process justifies a reconnect attempt, a plain tool error does not.
		if !client.Dead() {
			return call, err
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("MCP server %q did not answer", s.server.Name)
	}
	return mcp.Call{}, fmt.Errorf("MCP server %q is unreachable: %w", s.server.Name, lastErr)
}

// reconnect starts a fresh server process. It holds the session lock while
// doing so, which serialises competing reconnects from parallel tool calls
// into one spawn.
func (s *mcpSession) reconnect(ctx context.Context) (*mcp.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Another caller may have reconnected while this one waited on the lock.
	if s.client != nil && !s.client.Dead() {
		return s.client, nil
	}
	if s.client != nil {
		_ = s.client.Close()
		s.client = nil
	}
	client, err := mcp.Connect(ctx, s.server)
	if err != nil {
		return nil, err
	}
	s.client = client
	s.reconns++
	return client, nil
}

// close shuts the current process down, if any.
func (s *mcpSession) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		_ = s.client.Close()
		s.client = nil
	}
}

// CallTool satisfies mcpCaller so the tool adapter needs no special case for
// the reconnecting session.
func (s *mcpSession) CallTool(ctx context.Context, name string, arguments map[string]any) (mcp.Call, error) {
	return s.call(ctx, name, arguments)
}

// Dead reports whether the session has no live process, matching the mcpCaller
// contract the adapter's retry logic reads.
func (s *mcpSession) Dead() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client == nil || s.client.Dead()
}

// connectMCP is the one-shot connection path for callers that only need a
// snapshot of tools, such as a CLI list command.
func connectMCP(ctx context.Context, server mcp.Server) (*mcpSession, []Tool, bool) {
	client, err := mcp.Connect(ctx, server)
	if err != nil {
		return nil, nil, false
	}
	list, err := client.ListTools(ctx)
	if err != nil {
		_ = client.Close()
		return nil, nil, false
	}
	session := &mcpSession{server: server, client: client}
	tools := make([]Tool, 0, len(list))
	for _, item := range list {
		tools = append(tools, &mcpTool{
			client: session,
			server: server.Name,
			tool:   item,
			name:   mcpToolName(server.Name, item.Name),
		})
	}
	return session, tools, true
}

// ConnectMCP connects every configured MCP server and returns the tools they
// offer, plus a function that closes the clients. A server that fails to start
// is skipped rather than fatal: one broken server must not cost the agent its
// whole tool set. Each server's connection is a reconnecting session, so a
// process that dies later in the session is restarted on the next call
// instead of leaving its tools dead until the operator quits.
func ConnectMCP(ctx context.Context, workspace string) ([]Tool, func()) {
	registry, err := mcp.Load(workspace)
	if err != nil {
		return nil, func() {}
	}
	var tools []Tool
	var sessions []*mcpSession
	for _, server := range registry.Servers {
		session, serverTools, ok := connectMCP(ctx, server)
		if !ok {
			continue
		}
		tools = append(tools, serverTools...)
		sessions = append(sessions, session)
	}
	return tools, func() {
		for _, session := range sessions {
			session.close()
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
