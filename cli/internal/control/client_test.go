package control

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

func writeDescriptor(t *testing.T, dir string, desc *Descriptor) string {
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

func TestLoadDescriptorValidation(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		_, err := LoadDescriptorFrom(filepath.Join(t.TempDir(), "nope.json"))
		if err == nil || !strings.Contains(err.Error(), "not running") {
			t.Fatalf("expected not-running error, got: %v", err)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "control.json")
		if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadDescriptorFrom(path); err == nil {
			t.Fatal("expected invalid-json error")
		}
	})

	t.Run("protocol mismatch", func(t *testing.T) {
		path := writeDescriptor(t, t.TempDir(), &Descriptor{
			Protocol: 99,
			Address:  "127.0.0.1:1",
			Token:    "x",
			PID:      os.Getpid(),
		})
		_, err := LoadDescriptorFrom(path)
		if err == nil || !strings.Contains(err.Error(), "protocol") {
			t.Fatalf("expected protocol error, got: %v", err)
		}
	})

	t.Run("incomplete descriptor", func(t *testing.T) {
		path := writeDescriptor(t, t.TempDir(), &Descriptor{
			Protocol: ProtocolVersion,
			Address:  "",
			Token:    "",
			PID:      os.Getpid(),
		})
		_, err := LoadDescriptorFrom(path)
		if err == nil || !strings.Contains(err.Error(), "incomplete") {
			t.Fatalf("expected incomplete error, got: %v", err)
		}
	})
}

func TestLoadDescriptorStaleProcess(t *testing.T) {
	// INT32_MAX cannot be a live PID on any supported OS. On Windows the
	// liveness probe is a TCP reachability check to the descriptor address,
	// so 127.0.0.1:1 is unreachable and the descriptor is still rejected.
	const deadPID = 2147483647
	path := writeDescriptor(t, t.TempDir(), &Descriptor{
		Protocol: ProtocolVersion,
		Address:  "127.0.0.1:1",
		Token:    "x",
		PID:      deadPID,
	})
	if _, err := LoadDescriptorFrom(path); err == nil {
		t.Fatal("expected stale-process error")
	}
}

// TestSendRoundTrip drives Send against a fake loopback server that answers the
// control protocol, so the client's framing is verified without a real Termigo.
func TestSendRoundTrip(t *testing.T) {
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
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			return
		}
		resp, _ := json.Marshal(Response{
			Protocol: ProtocolVersion,
			ID:       req.ID,
			OK:       true,
			Result:   map[string]interface{}{"text": "the answer"},
		})
		_, _ = conn.Write(append(resp, '\n'))
	}()

	desc := &Descriptor{
		Protocol: ProtocolVersion,
		Address:  ln.Addr().String(),
		Token:    "test-token",
		PID:      0,
	}
	out, err := Send(desc, MethodQuery, map[string]interface{}{"prompt": "hi"}, 5*time.Second)
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !out.OK {
		t.Fatalf("expected ok response, got: %+v", out)
	}
	if out.Result["text"] != "the answer" {
		t.Fatalf("unexpected result: %v", out.Result)
	}
	if !strings.Contains(Describe(MethodQuery, out.Result), "the answer") {
		t.Fatalf("a query result should surface the answer text")
	}
}

// TestSendRejectsAnOversizedReply pins the protocol bound: a peer that answers
// without a newline must not be able to make the client read unbounded data.
func TestSendRejectsAnOversizedReply(t *testing.T) {
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
		_, _ = bufio.NewReader(conn).ReadBytes('\n')
		_, _ = conn.Write([]byte(strings.Repeat("x", maxMessageLen+32)))
	}()

	desc := &Descriptor{Address: ln.Addr().String(), Token: "t"}
	if _, err := Send(desc, MethodPing, nil, 2*time.Second); err == nil {
		t.Fatal("expected an oversized reply to be rejected")
	}
}

// TestResultOfSurfacesTheAppError keeps the app's error code and message intact:
// the CLI prints them, and that message is what names the values the app
// actually accepts.
func TestResultOfSurfacesTheAppError(t *testing.T) {
	resp := &Response{
		OK:    false,
		Error: &Error{Code: "invalid_params", Message: "'theme' is not writable from the terminal"},
	}
	_, err := resultOf(resp)
	if err == nil {
		t.Fatal("expected an error for a failed response")
	}
	if !strings.Contains(err.Error(), "invalid_params") ||
		!strings.Contains(err.Error(), "not writable from the terminal") {
		t.Fatalf("expected the app code and message, got: %v", err)
	}

	empty, err := resultOf(&Response{OK: true})
	if err != nil {
		t.Fatalf("an empty result must not be an error: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected an empty map, got: %v", empty)
	}
}
