package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// payloadRecorder captures the request a client actually sends, which is the
// only way to prove the encoders are wired into the request rather than merely
// written.
type payloadRecorder struct {
	mu      sync.Mutex
	body    map[string]any
	headers http.Header
	path    string
	query   string
}

func newPayloadRecorder(t *testing.T) (*payloadRecorder, *httptest.Server) {
	t.Helper()
	recorder := &payloadRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		var decoded map[string]any
		_ = json.Unmarshal(raw, &decoded)
		recorder.mu.Lock()
		recorder.body = decoded
		recorder.headers = request.Header.Clone()
		recorder.path = request.URL.Path
		recorder.query = request.URL.RawQuery
		recorder.mu.Unlock()
		// An empty 200 ends the stream cleanly, which is all this test needs.
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
	}))
	return recorder, server
}

func (r *payloadRecorder) payload(t *testing.T) map[string]any {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.body == nil {
		t.Fatalf("the client sent no request")
	}
	return r.body
}

// object walks a nested map by key, failing loudly when the shape is wrong.
func object(t *testing.T, root any, keys ...string) map[string]any {
	t.Helper()
	current, ok := root.(map[string]any)
	if !ok {
		t.Fatalf("expected an object at %v, got %#v", keys, root)
	}
	return current
}

func array(t *testing.T, root map[string]any, key string) []any {
	t.Helper()
	value, ok := root[key].([]any)
	if !ok {
		t.Fatalf("%q = %#v, want an array", key, root[key])
	}
	return value
}

func number(t *testing.T, root map[string]any, key string) float64 {
	t.Helper()
	value, ok := root[key].(float64)
	if !ok {
		t.Fatalf("%q = %#v, want a number", key, root[key])
	}
	return value
}

func readFileTool() ToolDef {
	return ToolDef{
		Name:        "read_file",
		Description: "read a file from disk",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string"},
			},
			"required": []any{"path"},
		},
	}
}

func TestAnthropicRequestCarriesSystemToolsAndLimits(t *testing.T) {
	recorder, server := newPayloadRecorder(t)
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "anthropic", Label: "Anthropic", Kind: KindAnthropic}, server.URL, "anthropic-key")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	temperature := 0.3
	collect(t, client, ChatRequest{
		Model:       "claude-sonnet-4-5",
		System:      "be brief",
		MaxTokens:   512,
		Temperature: &temperature,
		Messages:    []Message{{Role: RoleUser, Content: "hi"}},
		Tools:       []ToolDef{readFileTool()},
	})

	body := recorder.payload(t)
	if recorder.path != "/v1/messages" {
		t.Errorf("path = %q, want /v1/messages", recorder.path)
	}
	if body["system"] != "be brief" {
		t.Errorf("system = %#v", body["system"])
	}
	if number(t, body, "max_tokens") != 512 {
		t.Errorf("max_tokens = %v, want 512", body["max_tokens"])
	}
	if body["stream"] != true {
		t.Errorf("stream should be requested")
	}
	if number(t, body, "temperature") != 0.3 {
		t.Errorf("temperature = %v, want 0.3", body["temperature"])
	}
	tools := array(t, body, "tools")
	if len(tools) != 1 {
		t.Fatalf("tools = %#v, want one entry", tools)
	}
	entry := object(t, tools[0], "tools", "0")
	if entry["name"] != "read_file" || entry["description"] != "read a file from disk" {
		t.Errorf("tool = %#v", entry)
	}
	schema := object(t, entry["input_schema"], "input_schema")
	if schema["type"] != "object" {
		t.Errorf("input_schema = %#v", schema)
	}
	if recorder.headers.Get("x-api-key") != "anthropic-key" {
		t.Errorf("x-api-key = %q", recorder.headers.Get("x-api-key"))
	}
}

// TestAnthropicOAuthUsesTheClaudeCodeIdentity covers the Claude OAuth headers:
// the bearer is only accepted under the claude-cli User-Agent, the claude-code
// beta, the beta query, and without the API key header.
func TestAnthropicOAuthUsesTheClaudeCodeIdentity(t *testing.T) {
	recorder, server := newPayloadRecorder(t)
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "claude-oauth", Label: "Claude (OAuth)", Kind: KindAnthropic, OAuth: true}, server.URL, "oauth-token")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	collect(t, client, ChatRequest{
		Model:    "claude-sonnet-5",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	})

	if recorder.query != "beta=true" {
		t.Errorf("query = %q, want beta=true", recorder.query)
	}
	if got := recorder.headers.Get("User-Agent"); got != claudeCLIUserAgent {
		t.Errorf("User-Agent = %q, want %q", got, claudeCLIUserAgent)
	}
	if got := recorder.headers.Get("anthropic-beta"); !strings.Contains(got, "oauth-2025-04-20") || !strings.Contains(got, "claude-code-20250219") {
		t.Errorf("anthropic-beta = %q", got)
	}
	if recorder.headers.Get("x-app") != "cli" {
		t.Errorf("x-app = %q, want cli", recorder.headers.Get("x-app"))
	}
	if got := recorder.headers.Get("Authorization"); got != "Bearer oauth-token" {
		t.Errorf("Authorization = %q", got)
	}
	if recorder.headers.Get("x-api-key") != "" {
		t.Errorf("an OAuth request must not send x-api-key")
	}
	if recorder.headers.Get("anthropic-dangerous-direct-browser-access") != "true" {
		t.Errorf("anthropic-dangerous-direct-browser-access header missing")
	}
	if recorder.headers.Get("X-Stainless-Runtime-Version") != "v26.12.1" {
		t.Errorf("X-Stainless-Runtime-Version = %q, want v26.12.1", recorder.headers.Get("X-Stainless-Runtime-Version"))
	}
	if recorder.headers.Get("X-Stainless-Package-Version") != "0.128.0" {
		t.Errorf("X-Stainless-Package-Version = %q, want 0.128.0", recorder.headers.Get("X-Stainless-Package-Version"))
	}
	if meta, ok := recorder.body["metadata"].(map[string]any); !ok || !strings.Contains(fmt.Sprint(meta["user_id"]), "device_id") {
		t.Errorf("expected metadata.user_id in payload, got %v", recorder.body["metadata"])
	}
}

// TestAnthropicDefaultsMaxTokens guards the value that keeps a thinking model
// from truncating its own answer when the caller did not set a limit: the
// model's own ceiling where the catalog has one, 8192 for an unlisted id.
func TestAnthropicDefaultsMaxTokens(t *testing.T) {
	recorder, server := newPayloadRecorder(t)
	defer server.Close()

	client, _ := newHTTPClient(Provider{ID: "anthropic", Label: "Anthropic", Kind: KindAnthropic}, server.URL, "k")
	collect(t, client, ChatRequest{Model: "claude-sonnet-4-5", Messages: []Message{{Role: RoleUser, Content: "hi"}}})

	body := recorder.payload(t)
	if number(t, body, "max_tokens") != 64000 {
		t.Errorf("max_tokens = %v, want the model's 64000 ceiling", body["max_tokens"])
	}
	if _, present := body["tools"]; present {
		t.Errorf("tools must be omitted when none were offered")
	}
	if _, present := body["system"]; present {
		t.Errorf("system must be omitted when it is empty")
	}
	if _, present := body["temperature"]; present {
		t.Errorf("temperature must be omitted when the caller did not set one")
	}
}

func TestGoogleRequestCarriesFunctionDeclarationsAndThoughts(t *testing.T) {
	recorder, server := newPayloadRecorder(t)
	defer server.Close()

	client, _ := newHTTPClient(Provider{ID: "google", Label: "Google", Kind: KindGoogle}, server.URL, "google-key")
	collect(t, client, ChatRequest{
		Model:     "gemini-2.5-pro",
		System:    "be brief",
		MaxTokens: 256,
		Messages:  []Message{{Role: RoleUser, Content: "hi"}},
		Tools:     []ToolDef{readFileTool()},
	})

	body := recorder.payload(t)
	if !strings.Contains(recorder.path, ":streamGenerateContent") {
		t.Errorf("path = %q", recorder.path)
	}
	if !strings.Contains(recorder.query, "alt=sse") {
		t.Errorf("query = %q, want alt=sse", recorder.query)
	}
	if strings.Contains(recorder.query, "key=") {
		t.Errorf("the API key must never ride in the URL, query = %q", recorder.query)
	}
	if got := recorder.headers.Get("x-goog-api-key"); got != "google-key" {
		t.Errorf("x-goog-api-key = %q, want the key in a header", got)
	}
	instruction := object(t, body["systemInstruction"], "systemInstruction")
	instructionParts := array(t, instruction, "parts")
	instructionText := object(t, instructionParts[0], "systemInstruction", "parts", "0")
	if instructionText["text"] != "be brief" {
		t.Errorf("systemInstruction = %#v", instructionText)
	}
	tools := array(t, body, "tools")
	first := object(t, tools[0], "tools", "0")
	declarations := array(t, first, "functionDeclarations")
	declared := object(t, declarations[0], "functionDeclarations", "0")
	if declared["name"] != "read_file" {
		t.Errorf("declaration = %#v", declared)
	}
	parameters := object(t, declared["parameters"], "parameters")
	if parameters["type"] != "object" {
		t.Errorf("parameters = %#v", parameters)
	}

	generation := object(t, body["generationConfig"], "generationConfig")
	if number(t, generation, "maxOutputTokens") != 256 {
		t.Errorf("maxOutputTokens = %v, want 256", generation["maxOutputTokens"])
	}
	thinking := object(t, generation["thinkingConfig"], "thinkingConfig")
	if thinking["includeThoughts"] != true {
		t.Errorf("a 2.5 model should ask for thoughts, got %#v", thinking)
	}
}

// TestGoogleOmitsThoughtsForOlderModels pins the capability gate: sending
// includeThoughts to a model that does not support it is a hard request error.
func TestGoogleOmitsThoughtsForOlderModels(t *testing.T) {
	recorder, server := newPayloadRecorder(t)
	defer server.Close()

	client, _ := newHTTPClient(Provider{ID: "google", Label: "Google", Kind: KindGoogle}, server.URL, "k")
	collect(t, client, ChatRequest{
		Model:    "gemini-1.5-pro",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools:    []ToolDef{{Name: "bare"}},
	})

	body := recorder.payload(t)
	if generation, ok := body["generationConfig"].(map[string]any); ok {
		if _, present := generation["thinkingConfig"]; present {
			t.Errorf("gemini-1.5 must not be sent thinkingConfig: %#v", generation)
		}
	}
	tools := array(t, body, "tools")
	first := object(t, tools[0], "tools", "0")
	declarations := array(t, first, "functionDeclarations")
	declared := object(t, declarations[0], "functionDeclarations", "0")
	if _, present := declared["parameters"]; present {
		t.Errorf("a tool without a schema must not send parameters: %#v", declared)
	}
}

func TestOpenAIRequestCarriesVisionToolsAndHeaders(t *testing.T) {
	recorder, server := newPayloadRecorder(t)
	defer server.Close()

	client, _ := newHTTPClient(Provider{ID: "openrouter", Label: "OpenRouter", Kind: KindOpenAI}, server.URL, "or-key")
	collect(t, client, ChatRequest{
		Model:  "some/model",
		System: "be brief",
		Messages: []Message{
			{Role: RoleUser, Content: "what is this?", Images: []Image{{MediaType: "image/png", Data: "QUJD"}}},
			{Role: RoleAssistant, Content: "reading", ToolCalls: []ToolCall{{ID: "c1", Name: "read_file", Arguments: ""}}},
			{Role: RoleTool, ToolID: "c1", Content: "file body"},
		},
		Tools: []ToolDef{readFileTool()},
	})

	body := recorder.payload(t)
	messages := array(t, body, "messages")
	if len(messages) != 4 {
		t.Fatalf("messages = %d, want system plus three turns", len(messages))
	}
	system := object(t, messages[0], "messages", "0")
	if system["role"] != "system" || system["content"] != "be brief" {
		t.Errorf("system message = %#v", system)
	}
	user := object(t, messages[1], "messages", "1")
	parts := array(t, user, "content")
	text := object(t, parts[0], "part", "0")
	if text["type"] != "text" {
		t.Errorf("first part = %#v, want the text", text)
	}
	image := object(t, parts[1], "part", "1")
	if image["type"] != "image_url" {
		t.Fatalf("second part = %#v, want an image", image)
	}
	url := object(t, image["image_url"], "image_url")
	if url["url"] != "data:image/png;base64,QUJD" {
		t.Errorf("image url = %#v", url["url"])
	}

	assistant := object(t, messages[2], "messages", "2")
	calls := array(t, assistant, "tool_calls")
	call := object(t, calls[0], "tool_calls", "0")
	function := object(t, call["function"], "function")
	if function["arguments"] != "{}" {
		t.Errorf("an empty argument string must become {}, got %#v", function["arguments"])
	}

	result := object(t, messages[3], "messages", "3")
	if result["role"] != "tool" || result["tool_call_id"] != "c1" {
		t.Errorf("tool result = %#v", result)
	}

	tools := array(t, body, "tools")
	tool := object(t, tools[0], "tools", "0")
	if tool["type"] != "function" {
		t.Errorf("tool = %#v", tool)
	}
	if recorder.headers.Get("Authorization") != "Bearer or-key" {
		t.Errorf("Authorization = %q", recorder.headers.Get("Authorization"))
	}
	if recorder.headers.Get("HTTP-Referer") == "" || recorder.headers.Get("X-Title") != "Termixgo" {
		t.Errorf("openrouter needs the attribution headers, got %v", recorder.headers)
	}
}

func TestEncodeAnthropicToolsDefaultsTheSchema(t *testing.T) {
	encoded := encodeAnthropicTools([]ToolDef{{Name: "bare", Description: "no schema"}})
	if len(encoded) != 1 {
		t.Fatalf("encoded = %#v", encoded)
	}
	schema, ok := encoded[0]["input_schema"].(map[string]any)
	if !ok {
		t.Fatalf("input_schema = %#v", encoded[0]["input_schema"])
	}
	if schema["type"] != "object" {
		t.Errorf("a missing schema must become an empty object, got %#v", schema)
	}
}

func TestAnthropicUserContentKeepsImages(t *testing.T) {
	text := anthropicUserContent(Message{Content: "look", Images: []Image{{MediaType: "image/jpeg", Data: "AA"}}})
	blocks, ok := text.([]map[string]any)
	if !ok || len(blocks) != 2 {
		t.Fatalf("blocks = %#v, want text plus image", text)
	}
	if blocks[0]["type"] != "text" || blocks[0]["text"] != "look" {
		t.Errorf("first block = %#v", blocks[0])
	}
	source, ok := blocks[1]["source"].(map[string]any)
	if !ok || source["media_type"] != "image/jpeg" || source["data"] != "AA" {
		t.Errorf("image block = %#v", blocks[1])
	}

	// An image with no caption must not produce an empty text block.
	only := anthropicUserContent(Message{Images: []Image{{MediaType: "image/png", Data: "AA"}}})
	if blockList, ok := only.([]map[string]any); !ok || len(blockList) != 1 {
		t.Errorf("blocks = %#v, want just the image", only)
	}
	// No images means the plain string form, which the API accepts as-is.
	if only := anthropicUserContent(Message{Content: "plain"}); only != "plain" {
		t.Errorf("content = %#v, want the plain string", only)
	}
}

func TestRawObjectReturnsAnObjectForMalformedArguments(t *testing.T) {
	decoded := rawObject(`{"path":"a.go"}`)
	asMap, ok := decoded.(map[string]any)
	if !ok || asMap["path"] != "a.go" {
		t.Fatalf("decoded = %#v", decoded)
	}
	// Anthropic wants a real object. A parse failure must degrade to {} rather
	// than make the whole request unencodable.
	if got, ok := rawObject("not json").(map[string]any); !ok || len(got) != 0 {
		t.Errorf("malformed arguments = %#v, want an empty object", got)
	}
}

func TestEncodeGoogleContentsNamesTheModelTurn(t *testing.T) {
	encoded := encodeGoogleContents([]Message{
		{Role: RoleUser, Content: "go"},
		{Role: RoleAssistant, Content: "reading", ToolCalls: []ToolCall{{ID: "c", Name: "read_file", Arguments: `{"path":"a.go"}`}}},
		{Role: RoleTool, Name: "read_file", Content: "body"},
		{Role: RoleTool, Name: "grep", Content: "match"},
	})

	if len(encoded) != 3 {
		t.Fatalf("encoded = %d turns, want 3 (results must merge)", len(encoded))
	}
	if encoded[1]["role"] != "model" {
		t.Errorf("an assistant turn is called model in this API, got %v", encoded[1]["role"])
	}
	parts, ok := encoded[1]["parts"].([]map[string]any)
	if !ok || len(parts) != 2 {
		t.Fatalf("parts = %#v, want text plus functionCall", encoded[1]["parts"])
	}
	call, ok := parts[1]["functionCall"].(map[string]any)
	if !ok || call["name"] != "read_file" {
		t.Errorf("functionCall = %#v", parts[1]["functionCall"])
	}
	args, ok := call["args"].(map[string]any)
	if !ok || args["path"] != "a.go" {
		t.Errorf("args = %#v", call["args"])
	}
	merged, ok := encoded[2]["parts"].([]map[string]any)
	if !ok || len(merged) != 2 {
		t.Fatalf("consecutive results must merge into one user turn, got %#v", encoded[2]["parts"])
	}
	if encoded[2]["role"] != "user" {
		t.Errorf("results are a user turn, got %v", encoded[2]["role"])
	}
}

func TestGooglePartsNeverEndUpEmpty(t *testing.T) {
	// Both the assistant and the user turn must carry at least one part: an
	// empty parts array is rejected by the API.
	encoded := encodeGoogleContents([]Message{
		{Role: RoleUser},
		{Role: RoleAssistant},
	})
	for index, turn := range encoded {
		parts, ok := turn["parts"].([]map[string]any)
		if !ok || len(parts) == 0 {
			t.Fatalf("turn %d has no parts: %#v", index, turn)
		}
	}
	if encoded[0]["role"] != "user" || encoded[1]["role"] != "model" {
		t.Errorf("roles = %v, %v", encoded[0]["role"], encoded[1]["role"])
	}
}

func TestGoogleUserPartsKeepImages(t *testing.T) {
	parts := googleUserParts(Message{Content: "look", Images: []Image{{MediaType: "image/png", Data: "AA"}}})
	if len(parts) != 2 {
		t.Fatalf("parts = %#v", parts)
	}
	inline, ok := parts[1]["inlineData"].(map[string]any)
	if !ok || inline["mimeType"] != "image/png" || inline["data"] != "AA" {
		t.Errorf("inlineData = %#v", parts[1]["inlineData"])
	}
	if got := googleUserParts(Message{}); len(got) != 1 || got[0]["text"] != "" {
		t.Errorf("an empty user turn must still carry a text part, got %#v", got)
	}
}

func TestGoogleFunctionResponseSaysNoOutputWhenBlank(t *testing.T) {
	blank := googleFunctionResponse(Message{Name: "read_file"})
	inner, ok := blank["functionResponse"].(map[string]any)
	if !ok {
		t.Fatalf("functionResponse = %#v", blank)
	}
	response, ok := inner["response"].(map[string]any)
	if !ok || response["result"] != "(no output)" {
		t.Errorf("response = %#v, want the placeholder", inner["response"])
	}
	if inner["name"] != "read_file" {
		t.Errorf("name = %v, want the tool name Google matches on", inner["name"])
	}
}

func TestEncodeVisionContentSkipsAnEmptyCaption(t *testing.T) {
	parts := encodeVisionContent(Message{Images: []Image{{MediaType: "image/png", Data: "AA"}}})
	if len(parts) != 1 {
		t.Fatalf("parts = %#v, want only the image", parts)
	}
	if parts[0]["type"] != "image_url" {
		t.Errorf("part = %#v", parts[0])
	}
}

func TestNullableTurnsBlankIntoNull(t *testing.T) {
	// Some compatible endpoints reject an empty assistant string; null is the
	// shape they expect when a turn is tool calls only.
	if got := nullable("   "); got != nil {
		t.Errorf("nullable of blank = %#v, want nil", got)
	}
	if got := nullable("hello"); got != "hello" {
		t.Errorf("nullable = %#v", got)
	}
}

func TestExtraHeadersOnlyForOpenRouter(t *testing.T) {
	headers := map[string]string{}
	extraHeaders(headers, "openrouter")
	if len(headers) != 2 {
		t.Errorf("headers = %v, want the two attribution headers", headers)
	}
	clean := map[string]string{}
	extraHeaders(clean, "openai")
	if len(clean) != 0 {
		t.Errorf("headers = %v, want none for openai", clean)
	}
}

func TestWrapStreamErrorNamesAStallSeparately(t *testing.T) {
	stalled := wrapStreamError("Google", errStreamStalled)
	if !strings.Contains(stalled.Error(), "Google") {
		t.Errorf("err = %v, want the provider named", stalled)
	}
	// The stall branch deliberately drops the cause and keeps the advice: the
	// operator needs to know the connection went quiet, not that a sentinel
	// error exists.
	if !strings.Contains(stalled.Error(), "stopped sending data") {
		t.Errorf("err = %v, want the stall wording", stalled)
	}

	boom := errors.New("connection reset by peer")
	interrupted := wrapStreamError("Anthropic", boom)
	if !errors.Is(interrupted, boom) {
		t.Errorf("the cause should be unwrappable, got %v", interrupted)
	}
	if !strings.Contains(interrupted.Error(), "interrupted") {
		t.Errorf("err = %v, want an interrupted message", interrupted)
	}
	if _, isStall := StallError(interrupted, 0); isStall {
		t.Errorf("an interrupted stream is not a stall")
	}
}

func TestRetryableTransportSeparatesTransientFromPermanent(t *testing.T) {
	timeout := fmt.Errorf("dial: %w", &net.DNSError{Err: "timeout", IsTimeout: true})
	if !retryableTransport(timeout) {
		t.Errorf("a timeout is worth retrying")
	}
	if !retryableTransport(errors.New("connection refused")) {
		t.Errorf("a refused connection is worth retrying")
	}
	if !retryableTransport(io.ErrUnexpectedEOF) {
		t.Errorf("a truncated body is worth retrying")
	}
	if retryableTransport(errors.New("tls: failed to verify certificate: x509: certificate signed by unknown authority")) {
		t.Errorf("a certificate error will not fix itself; do not retry it")
	}
}

// TestClaudeOAuthCloaksToolsAndDecloaksTheStream covers the OAuth tool
// cloaking: client tools are suffixed and decoy CLI tools added on the way out,
// and the suffixed name is restored when the tool call streams back.
func TestClaudeOAuthCloaksToolsAndDecloaksTheStream(t *testing.T) {
	var gotTools []any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		gotTools, _ = body["tools"].([]any)
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(writer, "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"read_file_ide\"}}\n\n")
		fmt.Fprint(writer, "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n")
		fmt.Fprint(writer, "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
	}))
	defer server.Close()

	client, err := newHTTPClient(Provider{ID: "claude-oauth", Label: "Claude (OAuth)", Kind: KindAnthropic, OAuth: true}, server.URL, "sk-ant-oat-token")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}

	var name string
	err = client.Stream(context.Background(), ChatRequest{
		Model:    "claude-sonnet-5",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools:    []ToolDef{{Name: "read_file", Schema: map[string]any{"type": "object", "properties": map[string]any{}}}},
	}, func(event StreamEvent) error {
		if event.Type == EventToolCall && event.ToolCall != nil {
			name = event.ToolCall.Name
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if name != "read_file" {
		t.Errorf("decloaked tool name = %q, want read_file", name)
	}

	foundClient := false
	for _, entry := range gotTools {
		object, _ := entry.(map[string]any)
		if object["name"] == "read_file_ide" {
			foundClient = true
		}
	}
	if !foundClient {
		t.Errorf("the client tool should be sent suffixed: %#v", gotTools)
	}
	if len(gotTools) != 1 {
		t.Errorf("only the client's own tools should be offered, no decoys: %#v", gotTools)
	}
}

// The fingerprint is recorded from the Claude Code client's own billing header:
// version 2.1.325 and the prompt "say hi" produce 382.
func TestClaudeFingerprintMatchesTheClientsOwnHeader(t *testing.T) {
	if got := claudeFingerprint("say hi", "2.1.325"); got != "382" {
		t.Fatalf("fingerprint = %q, want 382", got)
	}
}

func TestClaudeBillingHeaderLeadsTheSystemBlocks(t *testing.T) {
	messages := []Message{
		{Role: RoleAssistant, Content: "earlier"},
		{Role: RoleUser, Content: "say hi\n<env>\ncwd: /x\n</env>"},
	}
	system := withClaudeBillingHeader([]map[string]any{{"type": "text", "text": "identity"}}, messages)
	blocks, ok := system.([]map[string]any)
	if !ok || len(blocks) != 2 {
		t.Fatalf("system = %#v", system)
	}
	want := "x-anthropic-billing-header: cc_version=" + claudeCLIVersion + "." + claudeFingerprint("say hi", claudeCLIVersion) + "; cc_entrypoint=cli;"
	if blocks[0]["text"] != want {
		t.Errorf("billing block = %q, want %q", blocks[0]["text"], want)
	}
	if blocks[1]["text"] != "identity" {
		t.Errorf("the identity must follow the billing block: %#v", blocks[1])
	}
}

func TestAnthropicModelTraitsMatchTheEndpointCatalog(t *testing.T) {
	// Values read from GET /v1/models on the subscription endpoint.
	for _, id := range []string{"claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-oauth-opus-5-5"} {
		traits, ok := anthropicModelTraits(id)
		if !ok || traits.maxOutput != 128000 || !traits.adaptive {
			t.Errorf("%s: traits = %+v ok=%v, want 128000 adaptive", id, traits, ok)
		}
	}
	if traits, ok := anthropicModelTraits("claude-opus-4-8"); !ok || traits.maxOutput != 128000 || !traits.adaptive {
		t.Errorf("claude-opus-4-8: %+v %v", traits, ok)
	}
	if traits, ok := anthropicModelTraits("claude-haiku-4-5-20251001"); !ok || traits.maxOutput != 64000 || traits.adaptive {
		t.Errorf("claude-haiku-4-5: %+v %v", traits, ok)
	}
	for _, id := range []string{"claude-3-haiku-20240307", "gpt-6-sol", "claude-opus-50", "claude-opus-4-60"} {
		if _, ok := anthropicModelTraits(id); ok {
			t.Errorf("%s should have no traits", id)
		}
	}
}

func anthropicProbeServer(t *testing.T, onBody func(map[string]any) (int, string)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		status, reply := onBody(body)
		if status != http.StatusOK {
			writer.WriteHeader(status)
			fmt.Fprint(writer, reply)
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(writer, "data: {\"type\":\"message_stop\"}\n\n")
	}))
}

func TestClaudeRequestUsesTheModelsOutputCeilingAndAdaptiveThinking(t *testing.T) {
	var got map[string]any
	server := anthropicProbeServer(t, func(body map[string]any) (int, string) { got = body; return http.StatusOK, "" })
	defer server.Close()
	client, err := newHTTPClient(Provider{ID: "claude-oauth", Label: "Claude (OAuth)", Kind: KindAnthropic, OAuth: true}, server.URL, "tok")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	temperature := 0.7
	if err := client.Stream(context.Background(), ChatRequest{Model: "claude-opus-5-5", Temperature: &temperature, Messages: []Message{{Role: RoleUser, Content: "hi"}}}, func(StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if got["max_tokens"] != float64(128000) {
		t.Errorf("max_tokens = %v, want 128000", got["max_tokens"])
	}
	thinking, _ := got["thinking"].(map[string]any)
	if thinking["type"] != "adaptive" || thinking["display"] != "summarized" {
		t.Errorf("thinking = %#v", got["thinking"])
	}
	if _, has := got["temperature"]; has {
		t.Errorf("a thinking request must not carry temperature: %#v", got["temperature"])
	}

	// An unlisted model keeps the old default, and a request above the
	// ceiling is clamped rather than refused.
	if err := client.Stream(context.Background(), ChatRequest{Model: "claude-3-haiku-20240307", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, func(StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if got["max_tokens"] != float64(8192) || got["thinking"] != nil {
		t.Errorf("unlisted model: max_tokens=%v thinking=%v", got["max_tokens"], got["thinking"])
	}
	if err := client.Stream(context.Background(), ChatRequest{Model: "claude-haiku-5-5", MaxTokens: 500000, Messages: []Message{{Role: RoleUser, Content: "hi"}}}, func(StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if got["max_tokens"] != float64(128000) {
		t.Errorf("clamped max_tokens = %v, want 128000", got["max_tokens"])
	}
}

func TestClaudeRequestRetriesOnceWithoutThinkingWhenRefused(t *testing.T) {
	calls := 0
	var second map[string]any
	server := anthropicProbeServer(t, func(body map[string]any) (int, string) {
		calls++
		if calls == 1 {
			return http.StatusBadRequest, `{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid ` + "`signature`" + ` in ` + "`thinking`" + ` block"}}`
		}
		second = body
		return http.StatusOK, ""
	})
	defer server.Close()
	client, err := newHTTPClient(Provider{ID: "claude-oauth", Label: "Claude (OAuth)", Kind: KindAnthropic, OAuth: true}, server.URL, "tok")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	if err := client.Stream(context.Background(), ChatRequest{Model: "claude-sonnet-5-5", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, func(StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2 (one refusal, one plain retry)", calls)
	}
	if _, has := second["thinking"]; has {
		t.Errorf("the retry must drop thinking: %#v", second["thinking"])
	}
}

func TestClaudeRequestDoesNotRetryAnUnrelated400(t *testing.T) {
	calls := 0
	server := anthropicProbeServer(t, func(map[string]any) (int, string) {
		calls++
		return http.StatusBadRequest, `{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 128001 > 128000"}}`
	})
	defer server.Close()
	client, err := newHTTPClient(Provider{ID: "claude-oauth", Label: "Claude (OAuth)", Kind: KindAnthropic, OAuth: true}, server.URL, "tok")
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	if err := client.Stream(context.Background(), ChatRequest{Model: "claude-sonnet-5-5", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, func(StreamEvent) error { return nil }); err == nil {
		t.Fatalf("expected the 400 to surface")
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1", calls)
	}
}

// An empty turn is refused by the endpoint ("text content blocks must be
// non-empty", "user messages must have non-empty content"; both measured) and,
// because it stays in the history, every later request fails the same way and
// the run stops for good. The encoder must never send one.
func TestAnthropicEncoderNeverSendsAnEmptyTurn(t *testing.T) {
	textOf := func(content any) []string {
		var out []string
		switch c := content.(type) {
		case string:
			out = append(out, c)
		case []map[string]any:
			for _, block := range c {
				if text, ok := block["text"].(string); ok {
					out = append(out, text)
				}
			}
		}
		return out
	}

	t.Run("an assistant turn with nothing in it is left out and the user turns around it merge", func(t *testing.T) {
		for _, blank := range []string{"", "   ", "\n\t"} {
			encoded := encodeAnthropicMessages([]Message{
				{Role: RoleUser, Content: "hi"},
				{Role: RoleAssistant, Content: blank},
				{Role: RoleUser, Content: "Reply with the single word OK."},
			})
			if len(encoded) != 1 || encoded[0]["role"] != "user" {
				t.Fatalf("blank=%q: encoded = %#v, want one merged user turn", blank, encoded)
			}
			got := textOf(encoded[0]["content"])
			if len(got) != 2 || got[0] != "hi" || got[1] != "Reply with the single word OK." {
				t.Errorf("blank=%q: merged text = %q", blank, got)
			}
		}
	})

	t.Run("a blank user turn is dropped", func(t *testing.T) {
		encoded := encodeAnthropicMessages([]Message{
			{Role: RoleUser, Content: "hi"},
			{Role: RoleAssistant, Content: "hello"},
			{Role: RoleUser, Content: ""},
		})
		if len(encoded) != 2 {
			t.Fatalf("encoded = %#v, want the blank user turn dropped", encoded)
		}
		if blank := encodeAnthropicMessages([]Message{{Role: RoleUser, Content: "  "}}); len(blank) != 0 {
			t.Errorf("a lone blank user turn must not be sent: %#v", blank)
		}
	})

	t.Run("an image-only user turn is kept", func(t *testing.T) {
		encoded := encodeAnthropicMessages([]Message{{Role: RoleUser, Images: []Image{{MediaType: "image/png", Data: "AAAA"}}}})
		if len(encoded) != 1 {
			t.Fatalf("encoded = %#v, want the image turn kept", encoded)
		}
	})

	t.Run("a tool turn and its result are untouched, and an empty result says so", func(t *testing.T) {
		encoded := encodeAnthropicMessages([]Message{
			{Role: RoleUser, Content: "go"},
			{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "toolu_1", Name: "get_time", Arguments: "{}"}}},
			{Role: RoleTool, ToolID: "toolu_1", Name: "get_time", Content: ""},
		})
		if len(encoded) != 3 || encoded[1]["role"] != "assistant" || encoded[2]["role"] != "user" {
			t.Fatalf("encoded = %#v", encoded)
		}
		results, _ := encoded[2]["content"].([]map[string]any)
		if len(results) != 1 || results[0]["type"] != "tool_result" || results[0]["content"] != "(no output)" {
			t.Errorf("tool result = %#v", results)
		}
	})
}

// The tools of an OAuth request carry no cache breakpoint (the real client sends
// none, and a 5m tool marker before a 1h system block is refused), while the
// API-key path keeps its tool marker.
func TestClaudeOAuthToolsCarryNoCacheBreakpoint(t *testing.T) {
	capture := func(oauth bool) []any {
		var tools []any
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			raw, _ := io.ReadAll(request.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			tools, _ = body["tools"].([]any)
			writer.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(writer, "data: {\"type\":\"message_stop\"}\n\n")
		}))
		defer server.Close()
		client, err := newHTTPClient(Provider{ID: "anthropic", Label: "Anthropic", Kind: KindAnthropic, OAuth: oauth}, server.URL, "tok")
		if err != nil {
			t.Fatalf("newHTTPClient: %v", err)
		}
		err = client.Stream(context.Background(), ChatRequest{
			Model:    "claude-sonnet-5-5",
			Messages: []Message{{Role: RoleUser, Content: "hi"}},
			Tools: []ToolDef{
				{Name: "read_file", Schema: map[string]any{"type": "object", "properties": map[string]any{}}},
				{Name: "list_dir", Schema: map[string]any{"type": "object", "properties": map[string]any{}}},
			},
		}, func(StreamEvent) error { return nil })
		if err != nil {
			t.Fatalf("Stream: %v", err)
		}
		return tools
	}

	for _, entry := range capture(true) {
		if _, has := entry.(map[string]any)["cache_control"]; has {
			t.Errorf("an OAuth tool must carry no cache_control: %#v", entry)
		}
	}
	apiKeyTools := capture(false)
	if last, _ := apiKeyTools[len(apiKeyTools)-1].(map[string]any); last["cache_control"] == nil {
		t.Errorf("the API-key path keeps its tool cache marker: %#v", last)
	}
}
