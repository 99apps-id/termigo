package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// ProtocolVersion is the MCP protocol revision this client speaks.
const ProtocolVersion = "2024-11-05"

// defaultTimeout guards against MCP servers that never respond. npx-based
// servers can take a while to cold-start on first use.
const defaultTimeout = 60 * time.Second

// Client is a minimal MCP client that talks JSON-RPC 2.0 to a local server
// over stdio. It supports initialization, tool discovery and tool calls,
// which is enough to inspect and exercise the servers Termigo manages.
type Client struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	responses map[int64]chan rpcResponse
	mu        sync.Mutex
	nextID    int64
	waitErr   chan error
	stderr    *stderrBuffer
}

// stderrBuffer keeps a bounded tail of the server's stderr so that startup
// failures can be reported back to the user.
type stderrBuffer struct {
	mu  sync.Mutex
	buf []byte
}

const maxStderrBytes = 16 * 1024

func (buffer *stderrBuffer) write(data []byte) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	buffer.buf = append(buffer.buf, data...)
	if len(buffer.buf) > maxStderrBytes {
		buffer.buf = buffer.buf[len(buffer.buf)-maxStderrBytes:]
	}
}

func (buffer *stderrBuffer) string() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return string(buffer.buf)
}

// rpcResponse is a decoded JSON-RPC response.
type rpcResponse struct {
	Result json.RawMessage
	Error  string
}

// Call is the shape of a completed tool invocation.
type Call struct {
	// Text is the concatenated text content returned by the tool.
	Text string `json:"text"`
	// IsError is true when the server reported a tool failure.
	IsError bool `json:"isError"`
}

// Connect starts the MCP server process and performs the MCP handshake.
func Connect(ctx context.Context, server Server) (*Client, error) {
	command := exec.Command(server.Command, server.Args...)
	command.Env = envFor(server.Env)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open server stdin: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open server stdout: %w", err)
	}
	stderrPipe, err := command.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("open server stderr: %w", err)
	}
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start MCP server %q: %w", server.Name, err)
	}

	stderr := &stderrBuffer{}
	client := &Client{
		cmd:       command,
		stdin:     stdin,
		responses: make(map[int64]chan rpcResponse),
		waitErr:   make(chan error, 1),
		stderr:    stderr,
	}
	go client.readLoop(stdout)
	go client.captureStderr(stderrPipe, stderr)
	go func() { client.waitErr <- command.Wait() }()

	// MCP handshake: initialize, then notify the server it can start.
	initializeCtx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	if _, err := client.call(initializeCtx, "initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "termigo", "version": "0.1.0"},
	}); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("initialize MCP server %q: %w", server.Name, err)
	}
	if err := client.notify("notifications/initialized", map[string]any{}); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("notify MCP server %q: %w", server.Name, err)
	}
	return client, nil
}

// ListTools returns the tools a connected server exposes.
func (client *Client) ListTools(ctx context.Context) ([]Tool, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	result, err := client.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var payload struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, fmt.Errorf("decode tools/list result: %w", err)
	}
	return payload.Tools, nil
}

// CallTool invokes one tool with the given arguments.
func (client *Client) CallTool(ctx context.Context, name string, arguments map[string]any) (Call, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	result, err := client.call(ctx, "tools/call", map[string]any{
		"name":      name,
		"arguments": arguments,
	})
	if err != nil {
		return Call{}, err
	}
	var payload struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return Call{}, fmt.Errorf("decode tools/call result: %w", err)
	}
	call := Call{IsError: payload.IsError}
	for _, block := range payload.Content {
		if block.Type == "text" {
			if call.Text != "" {
				call.Text += "\n"
			}
			call.Text += block.Text
		}
	}
	return call, nil
}

// Ping checks that the server is still responsive.
func (client *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	_, err := client.call(ctx, "ping", map[string]any{})
	return err
}

// Close terminates the server process. On Windows, Process.Kill() can race
// with pipe cleanup inside Cmd.Wait(), so every wait is bounded.
func (client *Client) Close() error {
	if client.cmd == nil || client.cmd.Process == nil {
		return nil
	}
	_ = client.stdin.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-client.waitErr:
			return
		case <-time.After(2 * time.Second):
		}
		if client.cmd.Process != nil {
			_ = client.cmd.Process.Kill()
		}
		select {
		case <-client.waitErr:
		case <-time.After(2 * time.Second):
		}
	}()
	select {
	case <-done:
	case <-time.After(6 * time.Second):
		if client.cmd.Process != nil {
			_ = client.cmd.Process.Kill()
		}
	}
	return nil
}

// call sends a request and waits for its response.
func (client *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := client.nextID
	client.nextID++
	response := make(chan rpcResponse, 1)

	client.mu.Lock()
	client.responses[id] = response
	client.mu.Unlock()
	defer func() {
		client.mu.Lock()
		delete(client.responses, id)
		client.mu.Unlock()
	}()

	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	if err := client.write(request); err != nil {
		return nil, err
	}

	select {
	case message := <-response:
		if message.Error != "" {
			return nil, fmt.Errorf("%s failed: %s", method, message.Error)
		}
		return message.Result, nil
	case err := <-client.waitErr:
		tail := client.stderr.string()
		if tail == "" {
			tail = "no stderr output"
		}
		return nil, fmt.Errorf("%s: server process exited (%v); stderr: %s", method, err, tail)
	case <-ctx.Done():
		return nil, fmt.Errorf("%s timed out", method)
	}
}

// notify sends a fire-and-forget JSON-RPC notification.
func (client *Client) notify(method string, params map[string]any) error {
	return client.write(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (client *Client) write(message any) error {
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if _, err := client.stdin.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("write to MCP server: %w", err)
	}
	return nil
}

func (client *Client) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var message json.RawMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		client.route(message)
	}
}

func (client *Client) route(message json.RawMessage) {
	var header struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(message, &header); err != nil || len(header.ID) == 0 || string(header.ID) == "null" {
		return // Notifications from the server are ignored.
	}
	var id int64
	if err := json.Unmarshal(header.ID, &id); err != nil {
		return
	}
	client.mu.Lock()
	response := client.responses[id]
	client.mu.Unlock()
	if response == nil {
		return
	}
	var rpc struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Result json.RawMessage `json:"result"`
	}
	_ = json.Unmarshal(message, &rpc)
	if rpc.Error != nil {
		response <- rpcResponse{Error: rpc.Error.Message}
		return
	}
	response <- rpcResponse{Result: rpc.Result}
}

func (client *Client) captureStderr(reader io.Reader, buffer *stderrBuffer) {
	chunk := make([]byte, 4096)
	for {
		count, err := reader.Read(chunk)
		if count > 0 {
			buffer.write(chunk[:count])
		}
		if err != nil {
			return
		}
	}
}

// envFor builds the child environment: the parent environment plus overrides.
func envFor(overrides map[string]string) []string {
	environment := os.Environ()
	for key, value := range overrides {
		environment = append(environment, key+"="+value)
	}
	return environment
}
