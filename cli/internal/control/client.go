// Package control is the client side of Termigo's control plane: a running
// Termigo binds an ephemeral loopback TCP port and writes a discovery
// descriptor (address + a 256-bit token) to the user cache dir. Any local tool
// that holds the descriptor can drive the app over newline-delimited JSON.
//
// It lives in its own package because two very different callers need it: the
// MCP server mirror tools and the termigo CLI's own terminal surface. The
// command surface built on top of it is in app.go.
package control

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

const (
	// ProtocolVersion must match termigo_control_protocol::PROTOCOL_VERSION.
	ProtocolVersion = 1
	ConnectTimeout  = 2 * time.Second
	// ReadTimeout bounds a one-shot action (focus/open/status); those answer in
	// milliseconds.
	ReadTimeout = 15 * time.Second
	// QueryTimeout is the budget for a call that waits on the agent's full
	// answer, which can take minutes of tool steps.
	QueryTimeout  = 5 * time.Minute
	maxMessageLen = 64 * 1024
)

// Descriptor mirrors termigo_control_protocol::ControlDescriptor.
type Descriptor struct {
	Protocol   uint16 `json:"protocol"`
	Address    string `json:"address"`
	Token      string `json:"token"`
	PID        int    `json:"pid"`
	AppVersion string `json:"app_version"`
}

// Request mirrors termigo_control_protocol::ControlRequest.
type Request struct {
	Protocol uint16                 `json:"protocol"`
	ID       string                 `json:"id"`
	Token    string                 `json:"token"`
	Method   string                 `json:"method"`
	Params   map[string]interface{} `json:"params,omitempty"`
}

// Error mirrors termigo_control_protocol::ControlError.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Response mirrors termigo_control_protocol::ControlResponse.
type Response struct {
	Protocol uint16                 `json:"protocol"`
	ID       string                 `json:"id"`
	OK       bool                   `json:"ok"`
	Result   map[string]interface{} `json:"result,omitempty"`
	Error    *Error                 `json:"error,omitempty"`
}

// DescriptorPath is the same location the Rust side writes:
// <user-cache-dir>/termigo/control.json.
func DescriptorPath() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("could not resolve user cache directory: %w", err)
	}
	return filepath.Join(cache, "termigo", "control.json"), nil
}

// LoadDescriptor reads the descriptor from its well-known path.
func LoadDescriptor() (*Descriptor, error) {
	path, err := DescriptorPath()
	if err != nil {
		return nil, err
	}
	return LoadDescriptorFrom(path)
}

// LoadDescriptorFrom reads and sanity-checks the descriptor, verifying the
// owning process is still alive so a stale endpoint never receives the token.
func LoadDescriptorFrom(path string) (*Descriptor, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("Termigo is not running (no control descriptor at %s)", path)
	}
	var desc Descriptor
	if err := json.Unmarshal(raw, &desc); err != nil {
		return nil, fmt.Errorf("invalid Termigo control descriptor: %w", err)
	}
	if desc.Protocol != ProtocolVersion {
		return nil, fmt.Errorf("unsupported Termigo control protocol %d", desc.Protocol)
	}
	if desc.Address == "" || desc.Token == "" {
		return nil, fmt.Errorf("Termigo control descriptor is incomplete")
	}
	if runtime.GOOS == "windows" {
		if !tcpReachable(desc.Address) {
			return nil, fmt.Errorf("Termigo is not running (stale control descriptor)")
		}
	} else if !processAlive(desc.PID) {
		return nil, fmt.Errorf("Termigo is not running (stale control descriptor)")
	}
	return &desc, nil
}

// tcpReachable reports whether a TCP endpoint is accepting connections. It is
// used as the liveness probe on Windows, where signal-based process checks are
// unreliable.
func tcpReachable(address string) bool {
	conn, err := net.DialTimeout("tcp", address, ConnectTimeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
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

// Send sends one request over the loopback control socket and returns the
// parsed response. `readTimeout` bounds how long we wait for the answer
// (queries can take minutes of agent tool steps).
func Send(desc *Descriptor, method string, params map[string]interface{}, readTimeout time.Duration) (*Response, error) {
	conn, err := net.DialTimeout("tcp", desc.Address, ConnectTimeout)
	if err != nil {
		return nil, fmt.Errorf("could not connect to Termigo: %w", err)
	}
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetDeadline(time.Now().Add(ConnectTimeout + readTimeout))
	}

	req := Request{
		Protocol: ProtocolVersion,
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

	reader := bufio.NewReader(io.LimitReader(conn, maxMessageLen+1))
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, fmt.Errorf("could not read Termigo response: %w", err)
	}
	if len(line) > maxMessageLen {
		return nil, fmt.Errorf("Termigo response exceeded the protocol limit")
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("invalid Termigo response: %w", err)
	}
	return &resp, nil
}

// Call loads the descriptor, sends the request, and turns the response into a
// plain text result or a clean error.
func Call(method string, params map[string]interface{}, readTimeout time.Duration) (string, error) {
	result, err := CallResult(method, params, readTimeout)
	if err != nil {
		return "", err
	}
	return Describe(method, result), nil
}

// CallResult is Call without the text formatting: it returns the raw result so
// a caller that renders its own output (the setup wizard, the model picker) can
// read individual fields instead of re-parsing JSON that was pretty-printed for
// a model to read.
func CallResult(method string, params map[string]interface{}, readTimeout time.Duration) (map[string]interface{}, error) {
	desc, err := LoadDescriptor()
	if err != nil {
		return nil, err
	}
	resp, err := Send(desc, method, params, readTimeout)
	if err != nil {
		return nil, err
	}
	return resultOf(resp)
}

// resultOf unwraps a response into its result or an error carrying the app's own
// code and message, because that message is what tells the caller which values
// the app actually accepts.
func resultOf(resp *Response) (map[string]interface{}, error) {
	if !resp.OK {
		code, message := "request_failed", "Termigo rejected the request"
		if resp.Error != nil {
			code = resp.Error.Code
			message = resp.Error.Message
		}
		return nil, fmt.Errorf("%s: %s", code, message)
	}
	if resp.Result == nil {
		return map[string]interface{}{}, nil
	}
	return resp.Result, nil
}

// Describe makes a JSON result human-friendly for a text channel: a query
// prints the agent's answer, everything else the JSON.
func Describe(method string, result map[string]interface{}) string {
	if method == MethodQuery {
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
