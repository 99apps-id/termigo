package provider

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestOpenAICompatibleStream drives the chat-completions client against a fake
// server: it must send the prompt and decode the text deltas and usage.
func TestOpenAICompatibleStream(t *testing.T) {
	var gotAuth, gotModel string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotAuth = request.Header.Get("Authorization")
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n")
		fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n")
		fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2,\"total_tokens\":9}}\n\n")
		fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	client, err := NewClient("openai", server.URL, func(string) string { return "test-key" })
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	gotModel = "gpt-test"

	var text strings.Builder
	promptTokens := 0
	err = client.Stream(context.Background(), ChatRequest{
		Model:    gotModel,
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	}, func(event StreamEvent) error {
		switch event.Type {
		case EventTextDelta:
			text.WriteString(event.Text)
		case EventUsage:
			promptTokens = event.Usage.PromptTokens
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if text.String() != "Hello" {
		t.Errorf("text = %q, want Hello", text.String())
	}
	if promptTokens != 7 {
		t.Errorf("prompt tokens = %d, want 7", promptTokens)
	}
	if gotAuth != "Bearer test-key" {
		t.Errorf("Authorization = %q", gotAuth)
	}
}
