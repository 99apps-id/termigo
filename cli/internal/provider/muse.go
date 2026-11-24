package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
)

// museCLIVersion is the Muse Code CLI release whose identity Meta's backend
// gates native tool calls on, verified against the installed CLI (1.4.20) by
// capturing its request to a local endpoint.
const museCLIVersion = "1.4.24"

var museUserAgent = museBuildUserAgent()

func museBuildUserAgent() string {
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x86_64"
	}
	return fmt.Sprintf("muse-build/%s (non-interactive; %s-%s)", museCLIVersion, runtime.GOOS, arch)
}

var museSeq atomic.Uint64

// museClient speaks the Responses API served at api.meta.ai for a Muse
// login, under the Muse Code CLI identity. It shares the Codex encoder
// and decoder; only the headers, the namespace tool shape and the text
// tool fallback differ.
type museClient struct {
	*httpClient

	mu        sync.Mutex
	sessionID string
	textTools bool
}

func (c *museClient) session() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sessionID == "" {
		c.sessionID = c.SessionID()
	}
	return c.sessionID
}

func (c *museClient) resetSession() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sessionID = deriveSessionID(c.currentKey())
}

func (c *museClient) useTextTools() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.textTools
}

func (c *museClient) setTextTools() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.textTools = true
}

func (c *museClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	if c.useTextTools() {
		return c.streamTextTools(ctx, req, emit)
	}
	response, err := c.send(ctx, c.payload(req))
	if err == nil {
		defer response.Body.Close()
		return decodeResponsesStream(c.info.Label, response.Body, emit)
	}
	if isAttestationDenied(err) {
		c.setTextTools()
		return c.streamTextTools(ctx, req, emit)
	}
	if !isMuseAuthOrSessionError(err) {
		return err
	}
	c.resetSession()
	c.refreshKey()
	response, err = c.send(ctx, c.payload(req))
	if err != nil {
		if isAttestationDenied(err) {
			c.setTextTools()
			return c.streamTextTools(ctx, req, emit)
		}
		return err
	}
	defer response.Body.Close()
	return decodeResponsesStream(c.info.Label, response.Body, emit)
}

func (c *museClient) send(ctx context.Context, payload map[string]any) (*http.Response, error) {
	session := c.session()
	headers := map[string]string{
		"Authorization":                "Bearer " + c.currentKey(),
		"User-Agent":                   museUserAgent,
		"x-client-id":                  "tbh:exec",
		"x-tbh-session-id":             session,
		"x-meta-ai-gateway-session-id": session,
		"x-tbh-thread-id":              session,
		"x-tbh-root-session-id":        session,
		"x-tbh-agent-role":             "main",
	}
	return c.post(ctx, c.baseURL+"/responses", headers, payload)
}

func (c *museClient) payload(req ChatRequest) map[string]any {
	input := encodeResponsesInput(req)
	stampFunctionCallItems(input)
	tagCommentaryItems(input)
	payload := map[string]any{
		"model":  req.Model,
		"stream": true,
		"store":  false,
		"input":  input,
	}
	if instructions := strings.TrimSpace(req.System); instructions != "" {
		payload["instructions"] = instructions
	}
	if len(req.Tools) > 0 {
		// The official CLI registers its tools as one namespace tool, not
		// as a flat function list, and Meta serves native calls in that
		// shape to a Muse Code client.
		payload["tools"] = []map[string]any{{
			"type":        "namespace",
			"name":        "muse",
			"description": "Muse Code tool set.",
			"tools":       encodeResponsesTools(req.Tools),
		}}
	}
	payload["reasoning"] = map[string]any{"summary": "auto", "effort": museEffort(req.Effort)}
	payload["include"] = []string{"reasoning.encrypted_content"}
	if c.httpClient != nil {
		payload["prompt_cache_key"] = "tbh:main:" + c.session()
	}
	return payload
}

// museEffort maps the shared effort levels onto Meta's reasoning effort.
// The official CLI defaults to high, so an unset level lands there too.
func museEffort(effort string) string {
	switch strings.TrimSpace(effort) {
	case "low", "medium", "high", "max":
		return strings.TrimSpace(effort)
	}
	return "high"
}

// isAttestationDenied reports whether an error is Meta's client
// attestation refusal. The CLI status error carries no typed code, so the
// provider's code is matched in the message.
func isAttestationDenied(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "client_attestation_denied") ||
		strings.Contains(message, "attestation") ||
		strings.Contains(message, "muse code subscription")
}

func isMuseAuthOrSessionError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "401") ||
		strings.Contains(message, "404") ||
		strings.Contains(message, "unauthenticated") ||
		strings.Contains(message, "unauthorized") ||
		strings.Contains(message, "expired")
}

// stampFunctionCallItems adds the id and status Meta's Responses API
// expects on a replayed function_call item.
func stampFunctionCallItems(items []map[string]any) {
	for _, item := range items {
		if item["type"] != "function_call" {
			continue
		}
		if _, ok := item["id"]; !ok {
			callID, _ := item["call_id"].(string)
			if callID == "" {
				callID = "function"
			}
			item["id"] = "fc_" + callID
		}
		if _, ok := item["status"]; !ok {
			item["status"] = "completed"
		}
	}
}

// tagCommentaryItems labels replayed assistant messages with the phase
// Meta expects: commentary when a function_call follows, final otherwise.
func tagCommentaryItems(items []map[string]any) {
	for index, item := range items {
		if item["type"] != "message" || item["role"] != "assistant" {
			continue
		}
		phase := "final_answer"
		if index+1 < len(items) && items[index+1]["type"] == "function_call" {
			phase = "commentary"
		}
		item["phase"] = phase
	}
}

func validResponsesID(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

func responsesFunctionName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "unknown_tool"
	}
	return b.String()
}

// streamTextTools runs one step without a native tools field, carrying
// the tools in the instructions instead. It is the attestation fallback:
// the parsed tool_call blocks are emitted as ordinary ToolCall events, so
// the agent loop executes them locally exactly as it does a native call.
func (c *museClient) streamTextTools(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	response, err := c.send(ctx, c.textToolsPayload(req))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var text strings.Builder
	buffered := func(event StreamEvent) error {
		if event.Type == EventTextDelta {
			text.WriteString(event.Text)
			return nil
		}
		return emit(event)
	}
	if err := decodeResponsesStream(c.info.Label, response.Body, buffered); err != nil {
		return err
	}
	prose, calls := parseTextToolCalls(text.String(), req.Tools)
	if len(calls) == 0 {
		if text.Len() > 0 {
			return emit(StreamEvent{Type: EventTextDelta, Text: text.String()})
		}
		return nil
	}
	if strings.TrimSpace(prose) != "" {
		if err := emit(StreamEvent{Type: EventTextDelta, Text: strings.TrimSpace(prose)}); err != nil {
			return err
		}
	}
	for index := range calls {
		call := calls[index]
		if err := emit(StreamEvent{Type: EventToolCall, ToolCall: &call}); err != nil {
			return err
		}
	}
	return nil
}

func (c *museClient) textToolsPayload(req ChatRequest) map[string]any {
	instructions := strings.TrimSpace(req.System)
	if len(req.Tools) > 0 {
		instructions = strings.TrimSpace(instructions + "\n\n" + textToolProtocol(req.Tools))
	}
	payload := map[string]any{
		"model":  req.Model,
		"stream": true,
		"input":  encodeTextToolsInput(req),
	}
	if instructions != "" {
		payload["instructions"] = instructions
	}
	return payload
}

func textToolProtocol(tools []ToolDef) string {
	var out strings.Builder
	out.WriteString("Tool use (text protocol): the tools below are available, but they are not registered with this API request. Termigo executes them on the operator's machine and returns their output to you.\n")
	out.WriteString("To call a tool, end your reply with one block per call, in exactly this shape and with no text after the last block:\n")
	out.WriteString("```tool_call\n{\"name\":\"tool_name\",\"arguments\":{\"arg\":value}}\n```\n")
	out.WriteString("Tool outputs come back as tool_result blocks; read them and continue. When the task is finished, answer in plain text with no tool_call block.\n\nAvailable tools:\n")
	for _, tool := range tools {
		schema, err := json.Marshal(tool.Schema)
		if err != nil || len(schema) == 0 {
			schema = []byte("{}")
		}
		fmt.Fprintf(&out, "- %s: %s\n  arguments JSON schema: %s\n", tool.Name, tool.Description, schema)
	}
	return out.String()
}

func encodeTextToolsInput(req ChatRequest) []map[string]any {
	items := make([]map[string]any, 0, len(req.Messages))
	for _, message := range req.Messages {
		switch message.Role {
		case RoleUser:
			items = append(items, map[string]any{
				"type":    "message",
				"role":    "user",
				"content": responsesUserContent(message),
			})
		case RoleAssistant:
			var parts []string
			if strings.TrimSpace(message.Content) != "" {
				parts = append(parts, message.Content)
			}
			for _, call := range message.ToolCalls {
				parts = append(parts, textToolCallBlock(call.Name, call.Arguments))
			}
			if len(parts) == 0 {
				continue
			}
			items = append(items, map[string]any{
				"type":    "message",
				"role":    "assistant",
				"content": []map[string]any{{"type": "output_text", "text": strings.Join(parts, "\n\n")}},
			})
		case RoleTool:
			block, err := json.Marshal(map[string]string{
				"name":    message.Name,
				"call_id": message.ToolID,
				"output":  message.Content,
			})
			if err != nil {
				continue
			}
			items = append(items, map[string]any{
				"type":    "message",
				"role":    "user",
				"content": []map[string]any{{"type": "input_text", "text": "```tool_result\n" + string(block) + "\n```"}},
			})
		}
	}
	return items
}

func textToolCallBlock(name, arguments string) string {
	if !json.Valid([]byte(strings.TrimSpace(arguments))) {
		arguments = "{}"
	}
	block, err := json.Marshal(map[string]json.RawMessage{
		"name":      json.RawMessage(strconvQuote(name)),
		"arguments": json.RawMessage(arguments),
	})
	if err != nil {
		return "```tool_call\n{\"name\":\"" + name + "\",\"arguments\":{}}\n```"
	}
	return "```tool_call\n" + string(block) + "\n```"
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

var textToolBlockRE = regexp.MustCompile("(?s)(```(?:tool_call|tool-call|json)\\s*(.*?)```|<tool_call>\\s*(.*?)\\s*</tool_call>)")

// parseTextToolCalls splits a model reply into prose and tool_call blocks. A
// block naming a tool the request did not declare stays prose, so an example
// or quoted JSON in an answer is never executed.
// A block that does not parse is not a call: the reply then stays prose.
func parseTextToolCalls(text string, tools []ToolDef) (string, []ToolCall) {
	known := make(map[string]bool, len(tools))
	for _, tool := range tools {
		known[tool.Name] = true
	}
	matches := textToolBlockRE.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return strings.TrimSpace(text), nil
	}
	var prose strings.Builder
	var calls []ToolCall
	cursor := 0
	for _, match := range matches {
		prose.WriteString(text[cursor:match[0]])
		bodyStart, bodyEnd := match[4], match[5]
		if bodyStart < 0 {
			bodyStart, bodyEnd = match[6], match[7]
		}
		var parsed struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if bodyStart < 0 || json.Unmarshal([]byte(strings.TrimSpace(text[bodyStart:bodyEnd])), &parsed) != nil || strings.TrimSpace(parsed.Name) == "" || !known[strings.TrimSpace(parsed.Name)] {
			prose.WriteString(text[match[0]:match[1]])
			cursor = match[1]
			continue
		}
		arguments := strings.TrimSpace(string(parsed.Arguments))
		if arguments == "" || arguments == "null" {
			arguments = "{}"
		}
		var asString string
		if err := json.Unmarshal([]byte(arguments), &asString); err == nil {
			arguments = asString
		}
		if !json.Valid([]byte(arguments)) {
			prose.WriteString(text[match[0]:match[1]])
			cursor = match[1]
			continue
		}
		calls = append(calls, ToolCall{
			ID:        fmt.Sprintf("call_muse_%d", museSeq.Add(1)),
			Name:      strings.TrimSpace(parsed.Name),
			Arguments: arguments,
		})
		cursor = match[1]
	}
	prose.WriteString(text[cursor:])
	if len(calls) == 0 {
		return text, nil
	}
	return strings.TrimSpace(prose.String()), calls
}
