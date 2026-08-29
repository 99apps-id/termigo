package mcpserver

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

// A minimal client for Termigo's control plane, so the MCP server can drive a
// running Termigo the same way the bundled `termigo` CLI does. It reads the
// app's control descriptor (an ephemeral loopback TCP endpoint + a 256-bit
// token written to the user cache dir), verifies the owning process is alive,
// and speaks the newline-delimited JSON protocol over a loopback socket.

const (
	controlProtocolVersion = 1
	controlConnectTimeout  = 2 * time.Second
	// One-shot actions (focus/open/status) answer in milliseconds; a query
	// waits for the agent's full answer, so it gets its own long budget.
	controlReadTimeout  = 15 * time.Second
	controlQueryTimeout = 5 * time.Minute
	controlMaxMessage   = 64 * 1024
)

// ControlDescriptor mirrors termigo_control_protocol::ControlDescriptor.
type ControlDescriptor struct {
	Protocol   uint16 `json:"protocol"`
	Address    string `json:"address"`
	Token      string `json:"token"`
	PID        int    `json:"pid"`
	AppVersion string `json:"app_version"`
}

// ControlRequest mirrors termigo_control_protocol::ControlRequest.
type ControlRequest struct {
	Protocol uint16                 `json:"protocol"`
	ID       string                 `json:"id"`
	Token    string                 `json:"token"`
	Method   string                 `json:"method"`
	Params   map[string]interface{} `json:"params,omitempty"`
}

// ControlError mirrors termigo_control_protocol::ControlError.
type ControlError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ControlResponse mirrors termigo_control_protocol::ControlResponse.
type ControlResponse struct {
	Protocol uint16                 `json:"protocol"`
	ID       string                 `json:"id"`
	OK       bool                   `json:"ok"`
	Result   map[string]interface{} `json:"result,omitempty"`
	Error    *ControlError          `json:"error,omitempty"`
}

// controlDescriptorPath is the same location the Rust side writes:
// <user-cache-dir>/termigo/control.json.
func controlDescriptorPath() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("could not resolve user cache directory: %w", err)
	}
	return filepath.Join(cache, "termigo", "control.json"), nil
}

// loadControlDescriptor reads and sanity-checks the descriptor, verifying the
// owning process is still alive so a stale endpoint never receives the token.
func loadControlDescriptor() (*ControlDescriptor, error) {
	path, err := controlDescriptorPath()
	if err != nil {
		return nil, err
	}
	return loadControlDescriptorFrom(path)
}

// loadControlDescriptorFrom is the testable core of loadControlDescriptor.
func loadControlDescriptorFrom(path string) (*ControlDescriptor, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("Termigo is not running (no control descriptor at %s)", path)
	}
	var desc ControlDescriptor
	if err := json.Unmarshal(raw, &desc); err != nil {
		return nil, fmt.Errorf("invalid Termigo control descriptor: %w", err)
	}
	if desc.Protocol != controlProtocolVersion {
		return nil, fmt.Errorf("unsupported Termigo control protocol %d", desc.Protocol)
	}
	if desc.Address == "" || desc.Token == "" {
		return nil, fmt.Errorf("Termigo control descriptor is incomplete")
	}
	if !processAlive(desc.PID) {
		return nil, fmt.Errorf("Termigo is not running (stale control descriptor)")
	}
	return &desc, nil
}

// processAlive reports whether a process id refers to a live process. Signal 0
// is the standard liveness probe on unix; on Windows FindProcess always
// succeeds and signal probing is unsupported, so the TCP connect is the real
// check there.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

func randomRequestID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}

// sendControl sends one request over the loopback control socket and returns
// the parsed response. `readTimeout` bounds how long we wait for the answer
// (queries can take minutes of agent tool steps).
func sendControl(desc *ControlDescriptor, method string, params map[string]interface{}, readTimeout time.Duration) (*ControlResponse, error) {
	conn, err := net.DialTimeout("tcp", desc.Address, controlConnectTimeout)
	if err != nil {
		return nil, fmt.Errorf("could not connect to Termigo: %w", err)
	}
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetDeadline(time.Now().Add(controlConnectTimeout + readTimeout))
	}

	req := ControlRequest{
		Protocol: controlProtocolVersion,
		ID:       randomRequestID(),
		Token:    desc.Token,
		Method:   method,
		Params:   params,
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("could not encode control request: %w", err)
	}
	if _, err := conn.Write(append(encoded, '\n')); err != nil {
		return nil, fmt.Errorf("could not send control request: %w", err)
	}

	reader := bufio.NewReader(io.LimitReader(conn, controlMaxMessage+1))
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, fmt.Errorf("could not read Termigo response: %w", err)
	}
	if len(line) > controlMaxMessage {
		return nil, fmt.Errorf("Termigo response exceeded the protocol limit")
	}
	var resp ControlResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("invalid Termigo response: %w", err)
	}
	return &resp, nil
}

// callControl is the tool-facing helper: loads the descriptor, sends the
// request, and turns the response into a plain text result or a clean error.
func callControl(method string, params map[string]interface{}, readTimeout time.Duration) (string, error) {
	desc, err := loadControlDescriptor()
	if err != nil {
		return "", err
	}
	resp, err := sendControl(desc, method, params, readTimeout)
	if err != nil {
		return "", err
	}
	if !resp.OK {
		code, message := "request_failed", "Termigo rejected the request"
		if resp.Error != nil {
			code = resp.Error.Code
			message = resp.Error.Message
		}
		return "", fmt.Errorf("%s: %s", code, message)
	}
	return describeControlResult(method, resp.Result), nil
}

// describeControlResult makes the JSON result human-friendly for the MCP text
// channel: a query prints the agent's answer, everything else the JSON.
func describeControlResult(method string, result map[string]interface{}) string {
	if method == "query" {
		if text, ok := result["text"].(string); ok && text != "" {
			return text
		}
	}
	pretty, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", result)
	}
	return string(pretty)
}

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
		return callControl("status", nil, controlReadTimeout)
	case "termigo_focus":
		query := arg("query")
		if query == "" {
			return "", fmt.Errorf("termigo_focus requires a query")
		}
		return callControl("focus", map[string]interface{}{"query": query}, controlReadTimeout)
	case "termigo_open":
		path := arg("path")
		if path == "" {
			return "", fmt.Errorf("termigo_open requires a path")
		}
		return callControl("open", map[string]interface{}{"path": path}, controlReadTimeout)
	case "termigo_run":
		prompt := arg("prompt")
		if prompt == "" {
			return "", fmt.Errorf("termigo_run requires a prompt")
		}
		return callControl("run", map[string]interface{}{"prompt": prompt}, controlReadTimeout)
	case "termigo_query":
		prompt := arg("prompt")
		if prompt == "" {
			return "", fmt.Errorf("termigo_query requires a prompt")
		}
		return callControl("query", map[string]interface{}{"prompt": prompt}, controlQueryTimeout)
	default:
		return "", fmt.Errorf("unknown control tool %q", name)
	}
}
