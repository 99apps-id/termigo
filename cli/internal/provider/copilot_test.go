package provider

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCopilotStreamChatCompletionsAndMessages(t *testing.T) {
	var gotPath, gotAuth, gotIntegration, gotEditor, gotPlugin, gotAgent, gotSessionID, gotAnthropicVersion string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotIntegration = r.Header.Get("copilot-integration-id")
		gotEditor = r.Header.Get("editor-version")
		gotPlugin = r.Header.Get("editor-plugin-version")
		gotAgent = r.Header.Get("user-agent")
		gotSessionID = r.Header.Get("session_id")
		gotAnthropicVersion = r.Header.Get("anthropic-version")

		w.Header().Set("Content-Type", "text/event-stream")
		if strings.Contains(r.URL.Path, "messages") {
			fmt.Fprint(w, "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello from Claude on Copilot\"}}\n\n")
		} else {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello from GPT on Copilot\"}}]}\n\n")
		}
	}))
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "github-copilot", Label: "GitHub Copilot", Kind: KindCopilot, OAuth: true}, server.URL, "copilot-test-token")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}

	// 1. Test GPT model routes to /chat/completions
	var text strings.Builder
	err = client.Stream(context.Background(), ChatRequest{
		Model:    "gpt-5.4",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	}, func(event StreamEvent) error {
		if event.Type == EventTextDelta {
			text.WriteString(event.Text)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if gotPath != "/chat/completions" {
		t.Errorf("path = %q, want /chat/completions", gotPath)
	}
	if gotAuth != "Bearer copilot-test-token" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotIntegration != "vscode-chat" || gotEditor != "vscode/1.110.0" || gotPlugin != "copilot-chat/0.38.0" {
		t.Errorf("vscode headers mismatch: integration=%q editor=%q plugin=%q", gotIntegration, gotEditor, gotPlugin)
	}
	if gotAgent != "GitHubCopilotChat/0.38.0" {
		t.Errorf("user-agent = %q", gotAgent)
	}
	if gotSessionID == "" {
		t.Errorf("session_id header missing")
	}
	if text.String() != "Hello from GPT on Copilot" {
		t.Errorf("text = %q", text.String())
	}

	// 2. Test Claude model routes to /v1/messages
	text.Reset()
	err = client.Stream(context.Background(), ChatRequest{
		Model:    "claude-sonnet-5.5",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	}, func(event StreamEvent) error {
		if event.Type == EventTextDelta {
			text.WriteString(event.Text)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if gotPath != "/v1/messages" {
		t.Errorf("path = %q, want /v1/messages", gotPath)
	}
	if gotAnthropicVersion != "2023-06-01" {
		t.Errorf("anthropic-version = %q, want 2023-06-01", gotAnthropicVersion)
	}
	if text.String() != "Hello from Claude on Copilot" {
		t.Errorf("text = %q", text.String())
	}
}

// TestCopilotEscalatesToResponsesWhenChatCompletionsRejectsTheModel covers the
// models Copilot does not serve on /chat/completions: the client retries on
// /responses, and remembers the model so the next call skips the failed path.
func TestCopilotEscalatesToResponsesWhenChatCompletionsRejectsTheModel(t *testing.T) {
	var chatHits, responsesHits int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/chat/completions"):
			chatHits++
			writer.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(writer, `{"error":{"message":"The requested model is not accessible via the /chat/completions endpoint.","type":"invalid_request_error"}}`)
		case strings.HasSuffix(request.URL.Path, "/responses"):
			responsesHits++
			writer.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(writer, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello from responses\"}\n\n")
			fmt.Fprint(writer, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n")
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "github-copilot", Label: "GitHub Copilot", Kind: KindCopilot, OAuth: true}, server.URL, "copilot-token")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}

	var text strings.Builder
	stream := func() error {
		text.Reset()
		return client.Stream(context.Background(), ChatRequest{
			Model:    "mai-code-1.1-flash",
			Messages: []Message{{Role: RoleUser, Content: "hi"}},
		}, func(event StreamEvent) error {
			if event.Type == EventTextDelta {
				text.WriteString(event.Text)
			}
			return nil
		})
	}

	if err := stream(); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if text.String() != "hello from responses" {
		t.Errorf("text = %q, want the responses answer", text.String())
	}
	if chatHits != 1 || responsesHits != 1 {
		t.Errorf("first call: chatHits=%d responsesHits=%d, want 1 and 1", chatHits, responsesHits)
	}

	// The model is remembered, so the second call skips /chat/completions.
	if err := stream(); err != nil {
		t.Fatalf("second Stream: %v", err)
	}
	if chatHits != 1 || responsesHits != 2 {
		t.Errorf("second call: chatHits=%d responsesHits=%d, want 1 and 2", chatHits, responsesHits)
	}
}
