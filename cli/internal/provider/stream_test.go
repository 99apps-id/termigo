package provider

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// collect drains a client's stream into a slice for assertions.
func collect(t *testing.T, client Client, request ChatRequest) []StreamEvent {
	t.Helper()
	var events []StreamEvent
	err := client.Stream(context.Background(), request, func(event StreamEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	return events
}

func joinText(events []StreamEvent, kind StreamEventType) string {
	var builder strings.Builder
	for _, event := range events {
		if event.Type == kind {
			builder.WriteString(event.Text)
		}
	}
	return builder.String()
}

func toolCalls(events []StreamEvent) []ToolCall {
	var calls []ToolCall
	for _, event := range events {
		if event.Type == EventToolCall && event.ToolCall != nil {
			calls = append(calls, *event.ToolCall)
		}
	}
	return calls
}

func TestOpenAIStreamParsesTextReasoningToolsAndUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization header = %q", got)
		}
		if !strings.HasSuffix(request.URL.Path, "/chat/completions") {
			t.Errorf("path = %q", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		chunks := []string{
			`{"choices":[{"delta":{"reasoning_content":"let me think"}}]}`,
			`{"choices":[{"delta":{"content":"Hello "}}]}`,
			`{"choices":[{"delta":{"content":"world"}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.go\"}"}}]}}]}`,
			`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`,
			`[DONE]`,
		}
		for _, chunk := range chunks {
			fmt.Fprintf(writer, "data: %s\n\n", chunk)
		}
	}))
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "openai", Label: "OpenAI", Kind: KindOpenAI}, server.URL, "test-key")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	events := collect(t, client, ChatRequest{
		Model:    "gpt-5.4-mini",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools:    []ToolDef{{Name: "read_file", Description: "read", Schema: map[string]any{"type": "object"}}},
	})

	if got := joinText(events, EventTextDelta); got != "Hello world" {
		t.Errorf("text = %q, want %q", got, "Hello world")
	}
	if got := joinText(events, EventReasoningDelta); got != "let me think" {
		t.Errorf("reasoning = %q", got)
	}
	calls := toolCalls(events)
	if len(calls) != 1 {
		t.Fatalf("expected one tool call, got %d", len(calls))
	}
	if calls[0].Name != "read_file" || calls[0].Arguments != `{"path":"a.go"}` {
		t.Errorf("tool call = %+v", calls[0])
	}
	total := 0
	for _, event := range events {
		if event.Type == EventUsage && event.Usage != nil {
			total += event.Usage.TotalTokens
		}
	}
	if total != 18 {
		t.Errorf("usage total = %d, want 18", total)
	}
}

func TestOpenAIStreamReportsHTTPErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":{"message":"bad key"}}`))
	}))
	defer server.Close()

	client, _ := newHTTPClient(Provider{ID: "openai", Label: "OpenAI", Kind: KindOpenAI}, server.URL, "bad")
	err := client.Stream(context.Background(), ChatRequest{Model: "m"}, func(StreamEvent) error { return nil })
	if err == nil {
		t.Fatalf("expected an error")
	}
	if !strings.Contains(err.Error(), "bad key") || !strings.Contains(err.Error(), "401") {
		t.Errorf("the error should carry the provider message and status, got %v", err)
	}
	if !strings.Contains(err.Error(), "check the API key") {
		t.Errorf("a 401 should hint at the key, got %v", err)
	}
}

func TestAnthropicStreamParsesTextThinkingAndToolUse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("x-api-key"); got != "anthropic-key" {
			t.Errorf("x-api-key = %q", got)
		}
		if got := request.Header.Get("anthropic-version"); got == "" {
			t.Errorf("anthropic-version header is required")
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		events := []string{
			`{"type":"message_start","message":{"usage":{"input_tokens":9}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"considering"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"content_block_start","index":1,"content_block":{"type":"text"}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}`,
			`{"type":"content_block_stop","index":1}`,
			`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"grep"}}`,
			`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"pattern\":"}}`,
			`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"x\"}"}}`,
			`{"type":"content_block_stop","index":2}`,
			`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`,
			`{"type":"message_stop"}`,
		}
		for _, event := range events {
			fmt.Fprintf(writer, "event: x\ndata: %s\n\n", event)
		}
	}))
	defer server.Close()

	client, _ := newHTTPClient(Provider{ID: "anthropic", Label: "Anthropic", Kind: KindAnthropic}, server.URL, "anthropic-key")
	events := collect(t, client, ChatRequest{Model: "claude-sonnet-4-5", Messages: []Message{{Role: RoleUser, Content: "hi"}}})

	if got := joinText(events, EventTextDelta); got != "Done." {
		t.Errorf("text = %q", got)
	}
	if got := joinText(events, EventReasoningDelta); got != "considering" {
		t.Errorf("reasoning = %q", got)
	}
	calls := toolCalls(events)
	if len(calls) != 1 || calls[0].Name != "grep" || calls[0].Arguments != `{"pattern":"x"}` {
		t.Fatalf("tool call = %+v", calls)
	}
	prompt, completion := 0, 0
	for _, event := range events {
		if event.Type == EventUsage && event.Usage != nil {
			prompt += event.Usage.PromptTokens
			completion += event.Usage.CompletionTokens
		}
	}
	if prompt != 9 || completion != 5 {
		t.Errorf("usage = %d in, %d out; want 9 in, 5 out", prompt, completion)
	}
}

func TestEncodeAnthropicMessagesMergesToolResults(t *testing.T) {
	messages := []Message{
		{Role: RoleUser, Content: "go"},
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "a", Name: "read_file", Arguments: `{"path":"x"}`}, {ID: "b", Name: "grep", Arguments: `{"pattern":"y"}`}}},
		{Role: RoleTool, ToolID: "a", Name: "read_file", Content: "content a"},
		{Role: RoleTool, ToolID: "b", Name: "grep", Content: "content b"},
	}
	encoded := encodeAnthropicMessages(messages)
	if len(encoded) != 3 {
		t.Fatalf("consecutive tool results must merge into one user turn, got %d messages", len(encoded))
	}
	last := encoded[2]
	if last["role"] != "user" {
		t.Errorf("tool results must be user role, got %v", last["role"])
	}
	blocks, ok := last["content"].([]map[string]any)
	if !ok || len(blocks) != 2 {
		t.Fatalf("expected two tool_result blocks, got %#v", last["content"])
	}
	if blocks[0]["tool_use_id"] != "a" || blocks[1]["tool_use_id"] != "b" {
		t.Errorf("tool_use_id correlation is wrong: %+v", blocks)
	}
}

func TestGoogleStreamParsesTextThoughtsAndFunctions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !strings.Contains(request.URL.Path, ":streamGenerateContent") {
			t.Errorf("path = %q", request.URL.Path)
		}
		if request.URL.Query().Get("key") != "google-key" {
			t.Errorf("the API key should travel in the query, got %q", request.URL.Query().Get("key"))
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		chunks := []string{
			`{"candidates":[{"content":{"parts":[{"text":"pondering","thought":true}]}}]}`,
			`{"candidates":[{"content":{"parts":[{"text":"Answer"}]}}]}`,
			`{"candidates":[{"content":{"parts":[{"functionCall":{"name":"glob","args":{"pattern":"*.go"}}}]}}]}`,
			`{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}`,
		}
		for _, chunk := range chunks {
			fmt.Fprintf(writer, "data: %s\n\n", chunk)
		}
	}))
	defer server.Close()

	client, _ := newHTTPClient(Provider{ID: "google", Label: "Google", Kind: KindGoogle}, server.URL, "google-key")
	events := collect(t, client, ChatRequest{Model: "gemini-3-pro", Messages: []Message{{Role: RoleUser, Content: "hi"}}})

	if got := joinText(events, EventTextDelta); got != "Answer" {
		t.Errorf("text = %q", got)
	}
	if got := joinText(events, EventReasoningDelta); got != "pondering" {
		t.Errorf("thought text = %q", got)
	}
	calls := toolCalls(events)
	if len(calls) != 1 || calls[0].Name != "glob" {
		t.Fatalf("tool call = %+v", calls)
	}
	if calls[0].Arguments != `{"pattern":"*.go"}` {
		t.Errorf("arguments = %q", calls[0].Arguments)
	}
}

func TestGoogleModelPathNormalisesPrefix(t *testing.T) {
	if got := googleModelPath("models/gemini-2.5-pro"); got != "models/gemini-2.5-pro" {
		t.Errorf("got %q", got)
	}
	if got := googleModelPath("gemini-2.5-pro"); got != "models/gemini-2.5-pro" {
		t.Errorf("got %q", got)
	}
}

func TestNewClientRejectsMissingConfiguration(t *testing.T) {
	if _, err := NewClient("unknown-provider", "", nil); err == nil {
		t.Errorf("an unknown provider must be rejected")
	}
	if _, err := NewClient("openai-compatible", "", nil); err != nil {
		t.Errorf("openai-compatible has a fallback base URL and no key requirement, got %v", err)
	}
	if _, err := NewClient("anthropic", "", func(string) string { return "" }); err == nil {
		t.Errorf("a key-based provider without a key must be rejected")
	}
}
