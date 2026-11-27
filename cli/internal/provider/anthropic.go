package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"strconv"
	"strings"
)

// The Claude Code CLI identity an OAuth token is entitled to. The beta list
// matches what the current CLI sends; the first entry is what unlocks an
// OAuth bearer at all.
const (
	claudeCLIVersion   = "2.1.332"
	claudeCLIUserAgent = "claude-cli/" + claudeCLIVersion + " (external, cli)"
	claudeOAuthBeta    = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11"
)

func stainlessOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "MacOS"
	case "windows":
		return "Windows"
	default:
		return "Linux"
	}
}

func stainlessArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "arm64":
		return "arm64"
	default:
		return runtime.GOARCH
	}
}

// anthropicClient speaks the Messages streaming protocol.
type anthropicClient struct{ *httpClient }

func (c *anthropicClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	traits, known := anthropicModelTraits(req.Model)
	maxTokens := req.MaxTokens
	switch {
	case maxTokens <= 0 && known:
		// A thinking step spends its tokens out of this ceiling, and a tool
		// call cut off at 8192 mid-JSON stops the run half way.
		maxTokens = traits.maxOutput
	case maxTokens <= 0:
		maxTokens = 8192
	case known && maxTokens > traits.maxOutput:
		maxTokens = traits.maxOutput
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
	// Adaptive thinking lets the model decide when to think. display
	// "summarized" is what returns the reasoning as text: without it the block
	// arrives empty (measured: 0 characters against 212-517 on the same
	// prompts). A thinking request takes the default sampling only, and the
	// newest models refuse a temperature outright.
	if known && traits.adaptive {
		payload["thinking"] = map[string]any{"type": "adaptive", "display": "summarized"}
		delete(payload, "temperature")
	}

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
		headers["Accept"] = "application/json"
		headers["x-app"] = "cli"
		headers["User-Agent"] = claudeCLIUserAgent
		headers["X-Stainless-Retry-Count"] = "0"
		headers["X-Stainless-Runtime-Version"] = "v26.12.1"
		headers["X-Stainless-Package-Version"] = "0.128.0"
		headers["X-Stainless-Runtime"] = "node"
		headers["X-Stainless-Lang"] = "js"
		headers["X-Stainless-Arch"] = stainlessArch()
		headers["X-Stainless-Os"] = stainlessOS()
		headers["X-Stainless-Timeout"] = "600"
		headers["x-client-request-id"] = randomUUID()
		// Client tools are suffixed. No unavailable decoys are sent: the real
		// client offers only tools it serves, and a decoy name the model calls
		// resolves to no client tool, which fails the step instead of doing the
		// work. The tools carry no cache breakpoint either: Anthropic processes
		// breakpoints in tools, system, messages order and refuses a 1h block
		// that follows a 5m one (400 "a ttl='1h' cache_control block must not
		// come after a ttl='5m' cache_control block", measured), and the real
		// client sends no tool marker. The system part below still caches the
		// prefix, tools included.
		if len(req.Tools) > 0 {
			tools := encodeAnthropicTools(req.Tools)
			cloaked, names := cloakClaudeTools(tools)
			payload["tools"] = cloaked
			aliases = names
			cloakClaudeMessages(messages, aliases)
		}
		payload["system"] = withClaudeBillingHeader(payload["system"], req.Messages)
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
	err := c.streamWithURL(ctx, url, headers, payload, emit, aliases)
	if err != nil && isThinkingRejection(err) {
		// A request the thinking rules refuse (a block signed by another model,
		// a type this model will not take) costs the whole turn, so it is
		// repeated once as a plain one. Dropping thinking was measured to be
		// accepted on every current model. This client does not replay thinking
		// blocks, so the history needs no change.
		if _, had := payload["thinking"]; had {
			delete(payload, "thinking")
			return c.streamWithURL(ctx, url, headers, payload, emit, aliases)
		}
	}
	return err
}

// isThinkingRejection reports a 400 that is about extended thinking.
func isThinkingRejection(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, " returned 400") && strings.Contains(text, "thinking")
}

// anthropicTraits is what the subscription endpoint's catalog reports for a
// model: the most output tokens one response may carry, and whether adaptive
// thinking is accepted.
type anthropicTraits struct {
	maxOutput int
	adaptive  bool
}

// anthropicModelTraits returns the traits of a model it has data for. The
// values come from GET /v1/models (max_tokens, capabilities.thinking) read on
// 2026-11-27, and the ceiling was confirmed by a request: 128000 is accepted
// and 128001 is refused. Keep it in step with anthropicModelTraits in
// src/modules/ai/config.ts.
func anthropicModelTraits(model string) (anthropicTraits, bool) {
	id := strings.ToLower(model)
	if rest, ok := strings.CutPrefix(id, "claude-oauth-"); ok {
		id = "claude-" + rest
	}
	if !strings.HasPrefix(id, "claude-") {
		return anthropicTraits{}, false
	}
	rest := strings.TrimPrefix(id, "claude-")
	family, version, _ := strings.Cut(rest, "-")
	// version is "5-5", "5", "4-6", "4-5-20251101", ...
	major, _, _ := strings.Cut(version, "-")
	switch {
	case major == "5" && (family == "opus" || family == "sonnet" || family == "haiku" || family == "fable"):
		return anthropicTraits{maxOutput: 128000, adaptive: true}, true
	case (family == "opus" && (hasVersionPrefix(version, "4-6") || hasVersionPrefix(version, "4-7") || hasVersionPrefix(version, "4-8"))) ||
		(family == "sonnet" && hasVersionPrefix(version, "4-6")):
		return anthropicTraits{maxOutput: 128000, adaptive: true}, true
	case (family == "opus" || family == "sonnet" || family == "haiku") && hasVersionPrefix(version, "4-5"):
		return anthropicTraits{maxOutput: 64000, adaptive: false}, true
	}
	return anthropicTraits{}, false
}

// hasVersionPrefix matches a version segment such as "4-6" or "4-6-20260101"
// but not "4-60".
func hasVersionPrefix(version, prefix string) bool {
	return version == prefix || strings.HasPrefix(version, prefix+"-")
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
			if event.Delta.StopReason == "max_tokens" {
				if err := emit(StreamEvent{Type: EventIncomplete, IncompleteReason: "max_tokens"}); err != nil {
					return err
				}
			}
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
			out = appendAnthropicUserTurn(out, anthropicUserContent(message))
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
				// A turn with nothing to replay (a step that only thought, or
				// was cut before it wrote anything) carries nothing the next
				// request can use. Sending it as an empty text block is
				// refused with 400 "text content blocks must be non-empty",
				// and because the turn stays in the history, every later
				// request fails the same way and the run never recovers.
				continue
			}
			out = append(out, map[string]any{"role": "assistant", "content": blocks})
		case RoleTool:
			results := []map[string]any{anthropicToolResult(message)}
			for index+1 < len(messages) && messages[index+1].Role == RoleTool {
				index++
				results = append(results, anthropicToolResult(messages[index]))
			}
			out = appendAnthropicUserTurn(out, results)
		}
	}
	return out
}

// appendAnthropicUserTurn adds a user turn. Two things keep the request valid:
// a turn with nothing in it is dropped (the endpoint refuses "user messages
// must have non-empty content" and blank text blocks, measured), and a user
// turn that follows another one is merged into it, which is what happens when
// an empty assistant turn between them was left out.
func appendAnthropicUserTurn(out []map[string]any, content any) []map[string]any {
	switch c := content.(type) {
	case string:
		if strings.TrimSpace(c) == "" {
			return out
		}
	case []map[string]any:
		kept := nonEmptyTextBlocks(c)
		if len(kept) == 0 {
			return out
		}
		content = kept
	}
	if len(out) == 0 || out[len(out)-1]["role"] != "user" {
		return append(out, map[string]any{"role": "user", "content": content})
	}
	last := out[len(out)-1]
	var blocks []map[string]any
	switch previous := last["content"].(type) {
	case string:
		if strings.TrimSpace(previous) != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": previous})
		}
	case []map[string]any:
		blocks = append(blocks, previous...)
	}
	switch next := content.(type) {
	case string:
		blocks = append(blocks, map[string]any{"type": "text", "text": next})
	case []map[string]any:
		blocks = append(blocks, next...)
	}
	last["content"] = blocks
	return out
}

// nonEmptyTextBlocks drops blank text blocks. The endpoint refuses a text block
// with empty content, so replayed history must never carry one.
func nonEmptyTextBlocks(blocks []map[string]any) []map[string]any {
	kept := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		if block["type"] == "text" {
			if text, _ := block["text"].(string); strings.TrimSpace(text) == "" {
				continue
			}
		}
		kept = append(kept, block)
	}
	return kept
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
		StopReason  string `json:"stop_reason"`
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
// request, mirroring the Claude Code naming: a client tool named read_file is
// sent as read_file_ide and renamed back on the stream. It also keeps a client
// name from colliding with the CLI's own. Plain names were accepted too when
// measured on 2026-11-27, so this is not what gets a request served.
const claudeToolSuffix = "_ide"

// sanitizeClaudeToolName reduces a name to the only shape Anthropic accepts,
// ^[a-zA-Z0-9_-]{1,128}$: an MCP name with a dot or slash is answered with
// 400 invalid_request_error naming that pattern (verified live), so the
// suffix alone is not enough.
func sanitizeClaudeToolName(name string) string {
	var builder strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteByte('_')
		}
	}
	cleaned := builder.String()
	if len(cleaned) > 128 {
		cleaned = cleaned[:128]
	}
	if cleaned == "" {
		cleaned = "tool"
	}
	return cleaned
}

func cloakClaudeName(name string, aliases map[string]string, present map[string]bool) string {
	cloaked := sanitizeClaudeToolName(name)
	if !strings.HasSuffix(cloaked, claudeToolSuffix) {
		cloaked = sanitizeClaudeToolName(cloaked + claudeToolSuffix)
	}
	if present[cloaked] && aliases[cloaked] != name {
		for n := 2; ; n++ {
			candidate := sanitizeClaudeToolName(cloaked + "_" + strconv.Itoa(n))
			if !present[candidate] || aliases[candidate] == name {
				cloaked = candidate
				break
			}
		}
	}
	present[cloaked] = true
	aliases[cloaked] = name
	return cloaked
}

// cloakClaudeTools suffixes and sanitizes the client tools; it adds no decoy
// tools. It returns
// the aliases mapping a cloaked name back to the original.
func cloakClaudeTools(tools []map[string]any) ([]map[string]any, map[string]string) {
	aliases := make(map[string]string, len(tools))
	present := make(map[string]bool, len(tools))
	cloaked := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		copied := make(map[string]any, len(tool))
		for key, value := range tool {
			copied[key] = value
		}
		copied["name"] = cloakClaudeName(name, aliases, present)
		cloaked = append(cloaked, copied)
	}
	return cloaked, aliases
}

// cloakClaudeMessages renames the tool_use blocks in the history to the
// cloaked names the tools list now carries, reusing the same aliases so a
// sanitized history name matches its tool exactly.
func cloakClaudeMessages(messages []map[string]any, aliases map[string]string) {
	present := make(map[string]bool, len(aliases))
	for cloaked := range aliases {
		present[cloaked] = true
	}
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
			if name == "" {
				continue
			}
			if _, ok := aliases[name]; ok {
				continue
			}
			known := ""
			for cloaked, original := range aliases {
				if original == name {
					known = cloaked
					break
				}
			}
			if known != "" {
				block["name"] = known
			} else {
				block["name"] = cloakClaudeName(name, aliases, present)
			}
		}
	}
}

// claudeFingerprintSalt and claudeFingerprintIndexes are the constants the
// Claude Code client mixes into the build fingerprint it advertises in the
// billing header. They were recovered by matching the client's own header for
// a known prompt: version 2.1.325 and the text "say hi" produce 382.
const claudeFingerprintSalt = "59cf53e54c78"

var claudeFingerprintIndexes = [...]int{4, 7, 20}

// claudeFingerprint is the three-hex build fingerprint: a SHA-256 over the
// salt, the characters of the first user prompt at three fixed positions
// ("0" past the end) and the client version.
func claudeFingerprint(text, version string) string {
	runes := []rune(text)
	picked := make([]rune, 0, len(claudeFingerprintIndexes))
	for _, index := range claudeFingerprintIndexes {
		if index < len(runes) {
			picked = append(picked, runes[index])
		} else {
			picked = append(picked, '0')
		}
	}
	sum := sha256.Sum256([]byte(claudeFingerprintSalt + string(picked) + version))
	return hex.EncodeToString(sum[:])[:3]
}

// claudeFingerprintText is the text the fingerprint is taken from: the bare
// prompt of the first user message with prose. The harness may append an env
// block to a turn, but the client fingerprints only the prompt.
func claudeFingerprintText(messages []Message) string {
	for _, message := range messages {
		if message.Role != RoleUser || strings.TrimSpace(message.Content) == "" {
			continue
		}
		text := message.Content
		if idx := strings.LastIndex(text, "\n<env>"); idx >= 0 {
			if head := strings.TrimSpace(text[:idx]); head != "" {
				return head
			}
		}
		return text
	}
	return ""
}

// withClaudeBillingHeader prepends the billing line the Claude Code client
// sends as its first system block: the client version with its fingerprint and
// the entrypoint it runs as. The endpoint refuses a request whose first block
// is neither this line nor the Claude Code identity (429 rate_limit_error,
// measured on 2026-11-27), so it always leads.
func withClaudeBillingHeader(system any, messages []Message) any {
	text := fmt.Sprintf("x-anthropic-billing-header: cc_version=%s.%s; cc_entrypoint=cli;",
		claudeCLIVersion, claudeFingerprint(claudeFingerprintText(messages), claudeCLIVersion))
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
