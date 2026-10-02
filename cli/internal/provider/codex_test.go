package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestCodexStreamUsesTheResponsesAPI proves the Codex client posts to
// /responses with the account header and decodes the typed event feed.
func TestCodexStreamUsesTheResponsesAPI(t *testing.T) {
	var gotPath, gotAuth, gotAccount, gotOriginator, gotVersion, gotAgent, gotSessionID string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.Path
		gotAuth = request.Header.Get("Authorization")
		gotAccount = request.Header.Get("ChatGPT-Account-ID")
		gotOriginator = request.Header.Get("originator")
		gotVersion = request.Header.Get("version")
		gotAgent = request.Header.Get("User-Agent")
		gotSessionID = request.Header.Get("session_id")
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &gotBody)

		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(writer, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello \"}\n\n")
		fmt.Fprint(writer, "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"thinking\"}\n\n")
		fmt.Fprint(writer, "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}}\n\n")
		fmt.Fprint(writer, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n")
	}))
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "openai-codex", Label: "Codex", Kind: KindOpenAI}, server.URL, "oauth-token")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	codex, ok := client.(*codexClient)
	if !ok {
		t.Fatalf("client = %T, want *codexClient", client)
	}
	codex.SetAccountID("acct_9")

	var text, reasoning strings.Builder
	var calls []ToolCall
	var usage Usage
	err = codex.Stream(context.Background(), ChatRequest{
		Model:  "gpt-5.3-codex",
		System: "be brief",
		Messages: []Message{
			{Role: RoleUser, Content: "read a"},
			{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "call_0", Name: "grep", Arguments: "{}"}}},
			{Role: RoleTool, ToolID: "call_0", Name: "grep", Content: "done"},
		},
	}, func(event StreamEvent) error {
		switch event.Type {
		case EventTextDelta:
			text.WriteString(event.Text)
		case EventReasoningDelta:
			reasoning.WriteString(event.Text)
		case EventToolCall:
			calls = append(calls, *event.ToolCall)
		case EventUsage:
			usage = *event.Usage
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	if gotPath != "/responses" {
		t.Errorf("path = %q, want /responses", gotPath)
	}
	if gotAuth != "Bearer oauth-token" || gotAccount != "acct_9" || gotOriginator != "codex_cli_rs" {
		t.Errorf("headers: auth=%q account=%q originator=%q", gotAuth, gotAccount, gotOriginator)
	}
	// The backend gates newer models on the Codex CLI identity, so the version
	// header and User-Agent must carry a real release, not a placeholder.
	if gotVersion != codexCLIVersion || gotAgent != "codex_cli_rs/"+codexCLIVersion {
		t.Errorf("identity headers: version=%q user-agent=%q", gotVersion, gotAgent)
	}
	if gotSessionID == "" {
		t.Errorf("session_id header missing")
	}
	if gotBody["instructions"] != "be brief" || gotBody["store"] != false {
		t.Errorf("body = %v", gotBody)
	}
	if text.String() != "Hello " || reasoning.String() != "thinking" {
		t.Errorf("text=%q reasoning=%q", text.String(), reasoning.String())
	}
	if len(calls) != 1 || calls[0].Name != "read_file" || calls[0].ID != "call_1" {
		t.Errorf("calls = %+v", calls)
	}
	if usage.TotalTokens != 15 || usage.PromptTokens != 10 {
		t.Errorf("usage = %+v", usage)
	}
}

// TestCodexInputUsesResponseItems pins the request shape: tool results become
// function_call_output items, not chat tool messages.
func TestCodexInputUsesResponseItems(t *testing.T) {
	items := encodeResponsesInput(ChatRequest{Messages: []Message{
		{Role: RoleUser, Content: "hi"},
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "t", Arguments: "{}"}}},
		{Role: RoleTool, ToolID: "c1", Content: "out"},
	}})
	if len(items) != 3 {
		t.Fatalf("items = %v", items)
	}
	if items[0]["type"] != "message" || items[1]["type"] != "function_call" || items[2]["type"] != "function_call_output" {
		t.Errorf("item types = %v %v %v", items[0]["type"], items[1]["type"], items[2]["type"])
	}
	if items[2]["call_id"] != "c1" {
		t.Errorf("tool result should carry call_id, got %v", items[2])
	}
}

// TestCodexResponsesLiteMovesToolsAndInstructions covers the lite models: they
// take tools and instructions as input prefix items and reject the top-level
// tools and instructions fields the standard models use.
func TestCodexResponsesLiteMovesToolsAndInstructions(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &gotBody)
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(writer, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n")
	}))
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "openai-codex", Label: "Codex", Kind: KindOpenAI}, server.URL, "token")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	err = client.Stream(context.Background(), ChatRequest{
		Model:    "gpt-6-sol",
		System:   "be brief",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools: []ToolDef{{
			Name:   "read_file",
			Schema: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}},
		}},
	}, func(StreamEvent) error { return nil })
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	if _, present := gotBody["tools"]; present {
		t.Errorf("a lite request must not carry top-level tools")
	}
	if _, present := gotBody["instructions"]; present {
		t.Errorf("a lite request must not carry top-level instructions")
	}
	input, ok := gotBody["input"].([]any)
	if !ok || len(input) < 2 {
		t.Fatalf("input = %#v", gotBody["input"])
	}
	prefix := input[0].(map[string]any)
	if prefix["type"] != "additional_tools" || prefix["role"] != "developer" {
		t.Errorf("input[0] = %#v, want the additional_tools prefix", prefix)
	}
	instruction := input[1].(map[string]any)
	if instruction["type"] != "message" || instruction["role"] != "developer" {
		t.Errorf("input[1] = %#v, want the developer instructions", instruction)
	}
	reasoning, _ := gotBody["reasoning"].(map[string]any)
	if reasoning["context"] != "all_turns" {
		t.Errorf("reasoning = %#v, want context all_turns", reasoning)
	}
}
