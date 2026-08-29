package mcpserver

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeDescriptor(t *testing.T, dir string, desc *ControlDescriptor) string {
	t.Helper()
	path := filepath.Join(dir, "control.json")
	raw, err := json.Marshal(desc)
	if err != nil {
		t.Fatalf("marshal descriptor: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write descriptor: %v", err)
	}
	return path
}

func TestLoadControlDescriptorValidation(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		_, err := loadControlDescriptorFrom(filepath.Join(t.TempDir(), "nope.json"))
		if err == nil || !strings.Contains(err.Error(), "not running") {
			t.Fatalf("expected not-running error, got: %v", err)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "control.json")
		if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadControlDescriptorFrom(path); err == nil {
			t.Fatal("expected invalid-json error")
		}
	})

	t.Run("protocol mismatch", func(t *testing.T) {
		path := writeDescriptor(t, t.TempDir(), &ControlDescriptor{
			Protocol: 99,
			Address:  "127.0.0.1:1",
			Token:    "x",
			PID:      os.Getpid(),
		})
		_, err := loadControlDescriptorFrom(path)
		if err == nil || !strings.Contains(err.Error(), "protocol") {
			t.Fatalf("expected protocol error, got: %v", err)
		}
	})

	t.Run("incomplete descriptor", func(t *testing.T) {
		path := writeDescriptor(t, t.TempDir(), &ControlDescriptor{
			Protocol: controlProtocolVersion,
			Address:  "",
			Token:    "",
			PID:      os.Getpid(),
		})
		_, err := loadControlDescriptorFrom(path)
		if err == nil || !strings.Contains(err.Error(), "incomplete") {
			t.Fatalf("expected incomplete error, got: %v", err)
		}
	})
}

func TestLoadControlDescriptorStaleProcess(t *testing.T) {
	// INT32_MAX cannot be a live PID on any supported OS. Windows skips the
	// probe (processAlive returns true there), so this exercises the unix path.
	const deadPID = 2147483647
	path := writeDescriptor(t, t.TempDir(), &ControlDescriptor{
		Protocol: controlProtocolVersion,
		Address:  "127.0.0.1:1",
		Token:    "x",
		PID:      deadPID,
	})
	if processAlive(deadPID) {
		t.Skip("platform does not support the liveness probe")
	}
	if _, err := loadControlDescriptorFrom(path); err == nil {
		t.Fatal("expected stale-process error")
	}
}

// TestSendControlRoundTrip drives sendControl against a fake loopback server
// that answers the control protocol, so the client's framing is verified
// without a real Termigo.
func TestSendControlRoundTrip(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			return
		}
		var req ControlRequest
		if err := json.Unmarshal(line, &req); err != nil {
			return
		}
		resp, _ := json.Marshal(ControlResponse{
			Protocol: controlProtocolVersion,
			ID:       req.ID,
			OK:       true,
			Result:   map[string]interface{}{"text": "the answer"},
		})
		_, _ = conn.Write(append(resp, '\n'))
	}()

	desc := &ControlDescriptor{
		Protocol: controlProtocolVersion,
		Address:  ln.Addr().String(),
		Token:    "test-token",
		PID:      0,
	}
	out, err := sendControl(desc, "query", map[string]interface{}{"prompt": "hi"}, 5*time.Second)
	if err != nil {
		t.Fatalf("sendControl: %v", err)
	}
	if !out.OK {
		t.Fatalf("expected ok response, got: %+v", out)
	}
	if out.Result["text"] != "the answer" {
		t.Fatalf("unexpected result: %v", out.Result)
	}
	if !strings.Contains(describeControlResult("query", out.Result), "the answer") {
		t.Fatalf("query result should surface the answer text")
	}
}

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
