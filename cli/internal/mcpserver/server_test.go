package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPServerInitializeAndTools(t *testing.T) {
	srv := New(".")

	in := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
`)
	var out bytes.Buffer

	if err := srv.Serve(context.Background(), in, &out); err != nil {
		t.Fatalf("Serve failed: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 response lines, got %d", len(lines))
	}

	var initResp RPCResponse
	if err := json.Unmarshal([]byte(lines[0]), &initResp); err != nil {
		t.Fatalf("failed to unmarshal init response: %v", err)
	}
	if initResp.Error != nil {
		t.Errorf("init error: %+v", initResp.Error)
	}

	var toolsResp RPCResponse
	if err := json.Unmarshal([]byte(lines[1]), &toolsResp); err != nil {
		t.Fatalf("failed to unmarshal tools response: %v", err)
	}
	if toolsResp.Error != nil {
		t.Errorf("tools error: %+v", toolsResp.Error)
	}
}
