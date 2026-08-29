package mcpserver

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// RPCRequest represents a JSON-RPC 2.0 request.
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// RPCResponse represents a JSON-RPC 2.0 response.
type RPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
}

// RPCError represents a JSON-RPC 2.0 error object.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Tool describes an MCP tool definition.
type Tool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"inputSchema"`
}

// Server handles MCP JSON-RPC protocol over stdio.
type Server struct {
	workspace string
	// allowExec gates the shell-exec tool. It is off by default and only on
	// when TERMIGO_MCP_ALLOW_EXEC is set, so the RCE-capable surface is not
	// exposed automatically.
	allowExec bool
}

// New creates a new MCP server instance.
func New(workspace string) *Server {
	return &Server{workspace: workspace, allowExec: execAllowed()}
}

// execAllowed reports whether the shell-exec tool may be exposed. It reads the
// TERMIGO_MCP_ALLOW_EXEC env var, accepting 1/true/yes.
func execAllowed() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(mcpAllowExecEnv))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// Serve reads JSON-RPC requests from in and writes responses to out.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			s.sendError(out, nil, -32700, "Parse error")
			continue
		}

		s.handleRequest(out, req)
	}
	return scanner.Err()
}

func (s *Server) handleRequest(out io.Writer, req RPCRequest) {
	switch req.Method {
	case "initialize":
		s.sendResult(out, req.ID, map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"serverInfo": map[string]string{
				"name":    "termigo-mcp-server",
				"version": "1.0.0",
			},
			"capabilities": map[string]interface{}{
				"tools": map[string]bool{"listChanged": false},
			},
		})

	case "tools/list":
		tools := []Tool{}
		if s.allowExec {
			tools = append(tools, Tool{
				Name:        "termigo_pty_exec",
				Description: "Execute a command inside Termigo native terminal environment",
				InputSchema: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"command": map[string]string{"type": "string", "description": "Shell command to run"},
					},
					"required": []string{"command"},
				},
			})
		}
		tools = append(tools, Tool{
			Name:        "termigo_get_diagnostics",
			Description: "Get compiler/linter diagnostics from Termigo workspace",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]string{"type": "string", "description": "Optional relative file path"},
				},
			},
		})
		// Control-plane mirror: drive a running Termigo the same way the
		// bundled `termigo` CLI does. The app must be running (it owns the
		// control endpoint + token); every agent-driving call stays
		// approval-gated in the app.
		tools = append(tools, Tool{
			Name:        "termigo_status",
			Description: "Report Termigo's version, platform and live state (agent status, active model, workspace, today's cost)",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		})
		tools = append(tools, Tool{
			Name:        "termigo_focus",
			Description: "Focus a Termigo tab whose title, path or cwd matches the query",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]string{"type": "string", "description": "Substring of a tab's title, path or label"},
				},
				"required": []string{"query"},
			},
		})
		tools = append(tools, Tool{
			Name:        "termigo_open",
			Description: "Open a file in a Termigo editor tab (must be inside an authorized workspace)",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]string{"type": "string", "description": "Absolute file path to open"},
				},
				"required": []string{"path"},
			},
		})
		tools = append(tools, Tool{
			Name:        "termigo_run",
			Description: "Start an approval-gated agent task in Termigo's in-app agent (non-blocking)",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"prompt": map[string]string{"type": "string", "description": "The task to run"},
				},
				"required": []string{"prompt"},
			},
		})
		tools = append(tools, Tool{
			Name:        "termigo_query",
			Description: "Ask Termigo's agent a read-only question and wait for the text answer (can take minutes)",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"prompt": map[string]string{"type": "string", "description": "The question to answer read-only"},
				},
				"required": []string{"prompt"},
			},
		})
		s.sendResult(out, req.ID, map[string]interface{}{"tools": tools})

	case "tools/call":
		var params struct {
			Name      string                 `json:"name"`
			Arguments map[string]interface{} `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			s.sendError(out, req.ID, -32602, "Invalid params")
			return
		}

		if params.Name == "termigo_pty_exec" {
			if !s.allowExec {
				s.sendError(out, req.ID, -32001, "termigo_pty_exec is disabled. Set TERMIGO_MCP_ALLOW_EXEC=1 to enable it.")
				return
			}
			cmdStr, _ := params.Arguments["command"].(string)
			if cmdStr == "" {
				s.sendError(out, req.ID, -32602, "Missing command argument")
				return
			}
			if ok, reason := validateShellCommand(cmdStr); !ok {
				s.sendError(out, req.ID, -32602, reason)
				return
			}
			cwd, ok := safeWorkspaceCwd(s.workspace)
			if !ok {
				s.sendError(out, req.ID, -32602, "Invalid workspace")
				return
			}

			ctx, cancel := context.WithTimeout(context.Background(), execTimeoutSecs*time.Second)
			defer cancel()
			cmd := execCommand(ctx, cmdStr, cwd)
			output, timedOut, err := execCapped(ctx, cmd, maxExecOutputBytes)
			if timedOut {
				output = fmt.Sprintf("Command timed out after %ds.\n%s", execTimeoutSecs, output)
			} else if err != nil {
				output = fmt.Sprintf("Error: %v\nOutput: %s", err, output)
			}
			output = redactOutput(output)

			s.sendResult(out, req.ID, map[string]interface{}{
				"content": []map[string]string{
					{"type": "text", "text": output},
				},
			})
			return
		}

		if params.Name == "termigo_get_diagnostics" {
			path, _ := params.Arguments["path"].(string)
			text := s.runDiagnostics(context.Background(), path)
			s.sendResult(out, req.ID, map[string]interface{}{
				"content": []map[string]string{
					{"type": "text", "text": redactOutput(text)},
				},
			})
			return
		}

		// Control-plane mirror tools (termigo_status/focus/open/run/query).
		if isControlTool(params.Name) {
			text, err := callControlTool(params.Name, params.Arguments)
			if err != nil {
				s.sendError(out, req.ID, -32002, err.Error())
				return
			}
			s.sendResult(out, req.ID, map[string]interface{}{
				"content": []map[string]string{
					{"type": "text", "text": text},
				},
			})
			return
		}

		s.sendError(out, req.ID, -32601, fmt.Sprintf("Unknown tool: %s", params.Name))

	default:
		s.sendError(out, req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

func (s *Server) sendResult(out io.Writer, id interface{}, result interface{}) {
	resp := RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
	bytes, _ := json.Marshal(resp)
	fmt.Fprintf(out, "%s\n", string(bytes))
}

func (s *Server) sendError(out io.Writer, id interface{}, code int, message string) {
	resp := RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: message,
		},
	}
	bytes, _ := json.Marshal(resp)
	fmt.Fprintf(out, "%s\n", string(bytes))
}
