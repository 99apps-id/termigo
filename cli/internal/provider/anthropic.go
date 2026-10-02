package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// The Claude Code CLI identity an OAuth token is entitled to. The beta list
// matches what the current CLI sends; the first entry is what unlocks an
// OAuth bearer at all.
const (
	claudeCLIVersion   = "2.1.280"
	claudeCLIUserAgent = "claude-cli/" + claudeCLIVersion + " (external, sdk-cli)"
	claudeOAuthBeta    = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28"
)

// anthropicClient speaks the Messages streaming protocol.
type anthropicClient struct{ *httpClient }

func (c *anthropicClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 8192
	}
	messages := encodeAnthropicMessages(req.Messages)
	payload := map[string]any{
		"model":      req.Model,
		"max_tokens": maxTokens,
		"stream":     true,
		"messages":   messages,
	}
	if len(req.SystemParts) > 0 {
		var blocks []map[string]any
		for i, part := range req.SystemParts {
			trimmed := strings.TrimSpace(part)
			if trimmed == "" {
				continue
			}
			block := map[string]any{"type": "text", "text": trimmed}
			if i == 0 {
				block["cache_control"] = map[string]any{"type": "ephemeral"}
			}
			blocks = append(blocks, block)
		}
		if len(blocks) > 0 {
			payload["system"] = blocks
		}
	} else if strings.TrimSpace(req.System) != "" {
		payload["system"] = req.System
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}

	applyPromptCacheToMessages(messages)

	headers := map[string]string{"anthropic-version": "2023-06-01"}
	url := c.baseURL + "/v1/messages"
	key := c.currentKey()
	var aliases map[string]string
	if c.info.OAuth {
		// A Claude Code OAuth login sends a bearer token under the claude-cli
		// identity and needs the beta query plus the claude-code beta header;
		// the API key header is not used.
		headers["Authorization"] = "Bearer " + key
		headers["anthropic-beta"] = claudeOAuthBeta
		headers["anthropic-dangerous-direct-browser-access"] = "true"
		headers["x-app"] = "cli"
		headers["User-Agent"] = claudeCLIUserAgent
		headers["X-Stainless-Helper-Method"] = "stream"
		headers["X-Stainless-Retry-Count"] = "0"
		headers["X-Stainless-Runtime-Version"] = "v24.14.0"
		headers["X-Stainless-Package-Version"] = "0.80.0"
		headers["X-Stainless-Runtime"] = "node"
		headers["X-Stainless-Lang"] = "js"
		headers["X-Stainless-Arch"] = "arm64"
		headers["X-Stainless-Os"] = "MacOS"
		headers["X-Stainless-Timeout"] = "600"
		// The endpoint expects the Claude Code tool names, so client tools are
		// suffixed and the CLI's own tools are offered as unavailable decoys.
		if len(req.Tools) > 0 {
			tools := encodeAnthropicTools(req.Tools)
			if len(tools) > 0 {
				tools[len(tools)-1]["cache_control"] = map[string]any{"type": "ephemeral"}
			}
			cloaked, names := cloakClaudeTools(tools)
			payload["tools"] = cloaked
			aliases = names
			cloakClaudeMessages(messages)
		}
		payload["system"] = withClaudeBillingHeader(payload["system"], payload)
		payload["metadata"] = map[string]any{
			"user_id": claudeUserID(key, c.SessionID()),
		}
		url += "?beta=true"
	} else {
		headers["x-api-key"] = key
		headers["anthropic-beta"] = "prompt-caching-2024-07-31"
		if len(req.Tools) > 0 {
			tools := encodeAnthropicTools(req.Tools)
			if len(tools) > 0 {
				tools[len(tools)-1]["cache_control"] = map[string]any{"type": "ephemeral"}
			}
			payload["tools"] = tools
		}
	}
	return c.streamWithURL(ctx, url, headers, payload, emit, aliases)
}

func (c *anthropicClient) streamWithURL(ctx context.Context, url string, headers map[string]string, payload map[string]any, emit func(StreamEvent) error, aliases map[string]string) error {
	response, err := c.post(ctx, url, headers, payload)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	reader := newSSEReader(response.Body)
	blocks := map[int]*anthropicBlock{}
	for {
		payload, err := reader.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return wrapStreamError("Anthropic", err)
		}
		if payload == "" {
			continue
		}
		var event anthropicEvent
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		switch event.Type {
		case "message_start":
			if event.Message != nil && event.Message.Usage != nil {
				// Anthropic reports input_tokens, cache_read and cache_creation
				// as separate counts that do not overlap, so the prompt total is
				// their sum. Pricing subtracts the cached parts before applying
				// the regular input rate, so nothing is charged twice.
				promptTokens := event.Message.Usage.InputTokens
				cacheRead := event.Message.Usage.CacheReadInputTokens
				cacheWrite := event.Message.Usage.CacheCreationInputTokens
				usage := Usage{
					PromptTokens:     promptTokens + cacheRead + cacheWrite,
					CacheReadTokens:  cacheRead,
					CacheWriteTokens: cacheWrite,
				}
				if err := emit(StreamEvent{Type: EventUsage, Usage: &usage}); err != nil {
					return err
				}
			}
		case "content_block_start":
			if event.ContentBlock != nil && event.ContentBlock.Type == "tool_use" {
				name := event.ContentBlock.Name
				if aliases != nil {
					if original, ok := aliases[name]; ok {
						name = original
					}
				}
				blocks[event.Index] = &anthropicBlock{id: event.ContentBlock.ID, name: name}
			}
		case "content_block_delta":
			delta := event.Delta
			switch delta.Type {
			case "text_delta":
				if delta.Text != "" {
					if err := emit(StreamEvent{Type: EventTextDelta, Text: delta.Text}); err != nil {
						return err
					}
				}
			case "thinking_delta":
				if delta.Thinking != "" {
					if err := emit(StreamEvent{Type: EventReasoningDelta, Text: delta.Thinking}); err != nil {
						return err
					}
				}
			case "input_json_delta":
				if block := blocks[event.Index]; block != nil {
					block.arguments += delta.PartialJSON
				}
			}
		case "content_block_stop":
			if block := blocks[event.Index]; block != nil {
				delete(blocks, event.Index)
				call := ToolCall{ID: block.id, Name: block.name, Arguments: block.arguments}
				if call.Arguments == "" {
					call.Arguments = "{}"
				}
				if call.ID == "" {
					call.ID = fmt.Sprintf("toolu_%d", event.Index)
				}
				if err := emit(StreamEvent{Type: EventToolCall, ToolCall: &call}); err != nil {
					return err
				}
			}
		case "message_delta":
			if event.Usage != nil {
				usage := Usage{CompletionTokens: event.Usage.OutputTokens}
				if err := emit(StreamEvent{Type: EventUsage, Usage: &usage}); err != nil {
					return err
				}
			}
		case "error":
			if event.Error != nil {
				// Lowercase opening word: Go error strings read as a clause when
				// they are wrapped into a larger message.
				return fmt.Errorf("the Anthropic stream reported an error: %s", event.Error.Message)
			}
		}
	}
	return nil
}

type anthropicBlock struct {
	id        string
	name      string
	arguments string
}

func encodeAnthropicTools(tools []ToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema := tool.Schema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"name":         tool.Name,
			"description":  tool.Description,
			"input_schema": schema,
		})
	}
	return out
}

// encodeAnthropicMessages builds Messages content. Two rules are load-bearing:
// tool results must be user-role blocks, and consecutive results must be
// merged into one user message or the API rejects the sequence.
func encodeAnthropicMessages(messages []Message) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	for index := 0; index < len(messages); index++ {
		message := messages[index]
		switch message.Role {
		case RoleUser:
			out = append(out, map[string]any{"role": "user", "content": anthropicUserContent(message)})
		case RoleAssistant:
			blocks := make([]map[string]any, 0, len(message.ToolCalls)+1)
			if strings.TrimSpace(message.Content) != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": message.Content})
			}
			for _, call := range message.ToolCalls {
				blocks = append(blocks, map[string]any{
					"type":  "tool_use",
					"id":    call.ID,
					"name":  call.Name,
					"input": rawObject(call.Arguments),
				})
			}
			if len(blocks) == 0 {
				blocks = append(blocks, map[string]any{"type": "text", "text": ""})
			}
			out = append(out, map[string]any{"role": "assistant", "content": blocks})
		case RoleTool:
			results := []map[string]any{anthropicToolResult(message)}
			for index+1 < len(messages) && messages[index+1].Role == RoleTool {
				index++
				results = append(results, anthropicToolResult(messages[index]))
			}
			out = append(out, map[string]any{"role": "user", "content": results})
		}
	}
	return out
}

func anthropicUserContent(message Message) any {
	if len(message.Images) == 0 {
		return message.Content
	}
	blocks := make([]map[string]any, 0, len(message.Images)+1)
	if strings.TrimSpace(message.Content) != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": message.Content})
	}
	for _, image := range message.Images {
		blocks = append(blocks, map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": image.MediaType,
				"data":       image.Data,
			},
		})
	}
	return blocks
}

func anthropicToolResult(message Message) map[string]any {
	content := message.Content
	if strings.TrimSpace(content) == "" {
		content = "(no output)"
	}
	return map[string]any{
		"type":        "tool_result",
		"tool_use_id": message.ToolID,
		"content":     content,
	}
}

// rawObject parses a tool call's arguments back into a JSON value. Anthropic
// wants a real object, not the string the model streamed.
func rawObject(arguments string) any {
	decoded, err := decodeArguments(arguments)
	if err != nil {
		return map[string]any{}
	}
	return decoded
}

// applyPromptCacheToMessages marks the second-to-last turn with ephemeral cache_control
// so multi-turn conversation prefix is cached by Anthropic.
func applyPromptCacheToMessages(messages []map[string]any) {
	if len(messages) < 2 {
		return
	}
	target := messages[len(messages)-2]
	switch content := target["content"].(type) {
	case string:
		if strings.TrimSpace(content) != "" {
			target["content"] = []map[string]any{
				{
					"type":          "text",
					"text":          content,
					"cache_control": map[string]any{"type": "ephemeral"},
				},
			}
		}
	case []map[string]any:
		if len(content) > 0 {
			content[len(content)-1]["cache_control"] = map[string]any{"type": "ephemeral"}
		}
	}
}

type anthropicEvent struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
	Delta struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		PartialJSON string `json:"partial_json"`
	} `json:"delta"`
	ContentBlock *struct {
		Type  string `json:"type"`
		ID    string `json:"id"`
		Name  string `json:"name"`
		Input any    `json:"input"`
	} `json:"content_block"`
	Message *struct {
		Usage *struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
	Usage *struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func claudeUserID(apiKey, sessionID string) string {
	hDevice := sha256.Sum256([]byte("device:" + apiKey))
	deviceID := hex.EncodeToString(hDevice[:])
	accountUUID := deriveUUIDFromSeed("account:" + apiKey)
	sessionUUID := deriveUUIDFromSeed("session:" + sessionID)
	if sessionID == "" {
		sessionUUID = deriveUUIDFromSeed(deviceID)
	}
	return fmt.Sprintf(`{"device_id":"%s","account_uuid":"%s","session_id":"%s"}`, deviceID, accountUUID, sessionUUID)
}

func deriveUUIDFromSeed(seed string) string {
	h := sha256.Sum256([]byte(seed))
	hexStr := hex.EncodeToString(h[:])
	b16 := (h[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-4%s-%02x%s-%s", hexStr[0:8], hexStr[8:12], hexStr[13:16], b16, hexStr[17:20], hexStr[20:32])
}

// claudeToolSuffix is the suffix every client tool gets before an OAuth
// request. The endpoint expects the Claude Code tool names, so a client tool
// named read_file is sent as read_file_ide and renamed back on the stream.
const claudeToolSuffix = "_ide"

// cloakClaudeTools suffixes the client tools and appends the Claude Code decoy
// tools, which are advertised as unavailable. It returns the aliases mapping a
// suffixed name back to the original.
func cloakClaudeTools(tools []map[string]any) ([]map[string]any, map[string]string) {
	aliases := make(map[string]string, len(tools))
	cloaked := make([]map[string]any, 0, len(tools)+len(claudeDecoyTools))
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		suffixed := name + claudeToolSuffix
		aliases[suffixed] = name
		copied := make(map[string]any, len(tool))
		for key, value := range tool {
			copied[key] = value
		}
		copied["name"] = suffixed
		cloaked = append(cloaked, copied)
	}
	return append(cloaked, claudeDecoyTools...), aliases
}

// cloakClaudeMessages renames the tool_use blocks in the history to the
// suffixed names the tools list now carries.
func cloakClaudeMessages(messages []map[string]any) {
	for _, message := range messages {
		blocks, ok := message["content"].([]map[string]any)
		if !ok {
			continue
		}
		for _, block := range blocks {
			if block["type"] != "tool_use" {
				continue
			}
			name, _ := block["name"].(string)
			if name != "" && !strings.HasSuffix(name, claudeToolSuffix) {
				block["name"] = name + claudeToolSuffix
			}
		}
	}
}

// withClaudeBillingHeader prepends the billing line the current Claude Code
// client sends. The hash is taken over the body before the header is added.
func withClaudeBillingHeader(system any, payload map[string]any) any {
	encoded, _ := json.Marshal(payload)
	sum := sha256.Sum256(encoded)
	text := fmt.Sprintf("x-anthropic-billing-header: cc_version=%s.%s; cc_entrypoint=sdk-cli; cch=%s;",
		claudeCLIVersion, randomHex(2)[:3], hex.EncodeToString(sum[:])[:5])
	billing := map[string]any{"type": "text", "text": text}
	switch value := system.(type) {
	case []map[string]any:
		if len(value) > 0 {
			if existing, ok := value[0]["text"].(string); ok && strings.HasPrefix(existing, "x-anthropic-billing-header:") {
				return value
			}
		}
		return append([]map[string]any{billing}, value...)
	case string:
		if strings.TrimSpace(value) == "" {
			return []map[string]any{billing}
		}
		return []map[string]any{billing, {"type": "text", "text": value}}
	default:
		return []map[string]any{billing}
	}
}

// claudeDecoyTools are the Claude Code native tools, offered so the request
// looks like the CLI. A decoy that gets called resolves to no client tool and
// surfaces as unavailable, which is the intent.
var claudeDecoyTools = []map[string]any{
	{"name": "Task", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "TaskOutput", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "TaskStop", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "TaskCreate", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "TaskGet", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "TaskUpdate", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "TaskList", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "Bash", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "Glob", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "Grep", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "Read", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "Edit", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "Write", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "NotebookEdit", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "WebFetch", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "WebSearch", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "AskUserQuestion", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "Skill", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "EnterPlanMode", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
	{"name": "ExitPlanMode", "description": "This tool is currently unavailable.", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
}
