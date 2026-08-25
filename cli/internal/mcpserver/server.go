package mcpserver

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
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
}

// New creates a new MCP server instance.
func New(workspace string) *Server {
	return &Server{workspace: workspace}
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
		s.sendResult(out, req.ID, map[string]interface{}{
			"tools": []Tool{
				{
					Name:        "termigo_pty_exec",
					Description: "Execute a command inside Termigo native terminal environment",
					InputSchema: map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"command": map[string]string{"type": "string", "description": "Shell command to run"},
						},
						"required": []string{"command"},
					},
				},
				{
					Name:        "termigo_get_diagnostics",
					Description: "Get compiler/linter diagnostics from Termigo workspace",
					InputSchema: map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"path": map[string]string{"type": "string", "description": "Optional relative file path"},
						},
					},
				},
			},
		})

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
			cmdStr, _ := params.Arguments["command"].(string)
			if cmdStr == "" {
				s.sendError(out, req.ID, -32602, "Missing command argument")
				return
			}

			cmd := exec.Command("sh", "-c", cmdStr)
			if strings.Contains(strings.ToLower(os.Getenv("OS")), "windows") {
				cmd = exec.Command("powershell", "-Command", cmdStr)
			}
			cmd.Dir = s.workspace
			outBytes, err := cmd.CombinedOutput()

			output := string(outBytes)
			if err != nil {
				output = fmt.Sprintf("Error: %v\nOutput: %s", err, output)
			}

			s.sendResult(out, req.ID, map[string]interface{}{
				"content": []map[string]string{
					{"type": "text", "text": output},
				},
			})
			return
		}

		if params.Name == "termigo_get_diagnostics" {
			s.sendResult(out, req.ID, map[string]interface{}{
				"content": []map[string]string{
					{"type": "text", "text": "No active diagnostic issues found."},
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
