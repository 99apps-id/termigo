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

// TestMuseStreamUsesResponsesWithCLIIdentity proves the Muse client posts
// to /responses with the Muse Code CLI identity headers and the tools as
// one namespace tool, and decodes a native function call.
func TestMuseStreamUsesResponsesWithCLIIdentity(t *testing.T) {
	var gotPath, gotAgent, gotClientID, gotSession, gotRole string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.Path
		gotAgent = request.Header.Get("User-Agent")
		gotClientID = request.Header.Get("x-client-id")
		gotSession = request.Header.Get("x-tbh-session-id")
		gotRole = request.Header.Get("x-tbh-agent-role")
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &gotBody)
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(writer, "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"{}\"}}\n\n")
		fmt.Fprint(writer, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":7,\"output_tokens\":3,\"total_tokens\":10}}}\n\n")
	}))
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "muse", Label: "Meta Muse Code", Kind: KindMuse}, server.URL, "muse-key")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	if _, ok := client.(*museClient); !ok {
		t.Fatalf("client = %T, want *museClient", client)
	}
	var calls []ToolCall
	err = client.Stream(context.Background(), ChatRequest{
		Model:    "muse-spark-1.3",
		System:   "be brief",
		Messages: []Message{{Role: RoleUser, Content: "read a"}},
		Tools:    []ToolDef{{Name: "read_file", Description: "read", Schema: map[string]any{"type": "object"}}},
	}, func(event StreamEvent) error {
		if event.Type == EventToolCall {
			calls = append(calls, *event.ToolCall)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if gotPath != "/responses" {
		t.Errorf("path = %q, want /responses", gotPath)
	}
	if !strings.Contains(gotAgent, "muse-build/1.4.20") {
		t.Errorf("User-Agent = %q, want the Muse CLI build identity", gotAgent)
	}
	if gotClientID != "tbh:exec" || gotRole != "main" || gotSession == "" {
		t.Errorf("tbh headers client=%q role=%q session=%q", gotClientID, gotRole, gotSession)
	}
	tools, _ := gotBody["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %v, want one namespace tool", gotBody["tools"])
	}
	namespace, _ := tools[0].(map[string]any)
	if namespace["type"] != "namespace" || namespace["name"] != "muse" {
		t.Errorf("tools[0] = %v, want the muse namespace tool", namespace)
	}
	if _, present := gotBody["tool_choice"]; present {
		t.Errorf("the CLI sends no tool_choice: %v", gotBody)
	}
	if len(calls) != 1 || calls[0].Name != "read_file" {
		t.Errorf("calls = %+v, want the native read_file call", calls)
	}
}

// TestResponsesInputDropsColonReasoningAndSanitizesNames proves a stored
// reasoning item another backend issued with a colon-joined id and no
// encrypted content is dropped on replay, and a stored tool call whose
// name carries forbidden characters is replayed under a sanitized name.
func TestResponsesInputDropsColonReasoningAndSanitizesNames(t *testing.T) {
	input := encodeResponsesInput(ChatRequest{Messages: []Message{
		{Role: RoleAssistant, Content: "working", ReasoningItems: []ReasoningItem{
			{ID: "rs_6af9963ede4b22a2dd364581:rs_01a1def2e58774f28782785f96d54236"},
			{ID: "rs_2", EncryptedContent: "enc_def"},
		}, ToolCalls: []ToolCall{{ID: "call_1", Name: "run_appc_3</arg_value>", Arguments: "{}"}}},
	}})
	reasoning := 0
	for _, item := range input {
		if item["type"] == "reasoning" {
			reasoning++
			if id, _ := item["id"].(string); strings.Contains(id, ":") {
				t.Fatalf("colon reasoning id replayed: %v", item)
			}
		}
		if item["type"] == "function_call" && item["name"] != "run_appc_3__arg_value_" {
			t.Fatalf("function_call name = %v, want sanitized", item["name"])
		}
	}
	if reasoning != 1 {
		t.Fatalf("reasoning items = %d, want only the encrypted one kept", reasoning)
	}
}

// A json block that merely looks like a call is prose unless it names a tool
// the request declared: answers quote examples, and quoted text must not run.
func TestTextToolCallsOnlyForDeclaredTools(t *testing.T) {
	tools := []ToolDef{{Name: "read_file"}}
	reply := "Example:\n```json\n{\"name\":\"rm_everything\",\"arguments\":{}}\n```\nand\n```tool_call\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}\n```"
	prose, calls := parseTextToolCalls(reply, tools)
	if len(calls) != 1 || calls[0].Name != "read_file" {
		t.Fatalf("only the declared tool is a call: %+v", calls)
	}
	if !strings.Contains(prose, "rm_everything") {
		t.Fatalf("the undeclared block should stay in the prose: %q", prose)
	}
}
