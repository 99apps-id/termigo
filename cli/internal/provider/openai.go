package provider

import (
	"context"
	"encoding/json"
	"io"
	"strings"
)

// openAIClient speaks the chat-completions streaming protocol, which also
// covers xAI, Groq, Cerebras, DeepSeek, Mistral, Qwen, Zhipu, OpenRouter,
// LM Studio, MLX, Ollama's compatible endpoint and any custom endpoint.
type openAIClient struct{ *httpClient }

// streamOptionsProviders are the servers known to accept the OpenAI
// stream_options field. Sending it to a server that rejects unknown fields
// would fail the whole request, so the rest go without.
var streamOptionsProviders = map[string]bool{
	"openai": true, "groq": true, "cerebras": true, "deepseek": true,
	"xai": true, "mistral": true, "openrouter": true, "qwen": true, "zhipu": true,
}

func (c *openAIClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	payload := map[string]any{
		"model":    req.Model,
		"stream":   true,
		"messages": c.encodeMessages(req),
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if len(req.Tools) > 0 {
		payload["tools"] = encodeOpenAITools(req.Tools)
		payload["tool_choice"] = "auto"
	}
	if streamOptionsProviders[c.info.ID] {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}

	headers := map[string]string{}
	key := c.currentKey()
	if key != "" {
		headers["Authorization"] = "Bearer " + key
	}
	extraHeaders(headers, c.info.ID)

	return c.streamWithURL(ctx, c.baseURL+"/chat/completions", headers, payload, emit)
}

func (c *openAIClient) streamWithURL(ctx context.Context, url string, headers map[string]string, payload map[string]any, emit func(StreamEvent) error) error {
	response, err := c.post(ctx, url, headers, payload)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	reader := newSSEReader(response.Body)
	accumulator := newToolCallAccumulator()
	// A server may repeat the request-wide usage on every chunk, so the increase
	// is emitted rather than each raw report: the agent sums what it is handed,
	// and forwarding repeats charged the same tokens once per chunk.
	usage := &cumulativeUsage{}
	for {
		payload, err := reader.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return wrapStreamError(c.info.Label, err)
		}
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk openAIChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if chunk.Usage != nil {
			cached := 0
			if chunk.Usage.PromptTokensDetails != nil {
				cached = chunk.Usage.PromptTokensDetails.CachedTokens
			}
			if step, ok := usage.step(Usage{
				PromptTokens:     chunk.Usage.PromptTokens,
				CompletionTokens: chunk.Usage.CompletionTokens,
				TotalTokens:      chunk.Usage.TotalTokens,
				CacheReadTokens:  cached,
			}); ok {
				if err := emit(StreamEvent{Type: EventUsage, Usage: &step}); err != nil {
					return err
				}
			}
		}
		for _, choice := range chunk.Choices {
			delta := choice.Delta
			if delta.Content != "" {
				if err := emit(StreamEvent{Type: EventTextDelta, Text: delta.Content}); err != nil {
					return err
				}
			}
			if thinking := delta.thinking(); thinking != "" {
				if err := emit(StreamEvent{Type: EventReasoningDelta, Text: thinking}); err != nil {
					return err
				}
			}
			for _, call := range delta.ToolCalls {
				accumulator.add(call)
			}
		}
	}

	for _, call := range accumulator.finish() {
		if err := emit(StreamEvent{Type: EventToolCall, ToolCall: &call}); err != nil {
			return err
		}
	}
	return nil
}

// encodeMessages flattens the shared message shape into chat-completions
// messages.
func (c *openAIClient) encodeMessages(req ChatRequest) []map[string]any {
	messages := make([]map[string]any, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.System) != "" {
		messages = append(messages, map[string]any{"role": "system", "content": req.System})
	}
	for _, message := range req.Messages {
		switch message.Role {
		case RoleAssistant:
			entry := map[string]any{"role": "assistant", "content": nullable(message.Content)}
			if len(message.ToolCalls) > 0 {
				calls := make([]map[string]any, 0, len(message.ToolCalls))
				for _, call := range message.ToolCalls {
					arguments := call.Arguments
					if strings.TrimSpace(arguments) == "" {
						arguments = "{}"
					}
					calls = append(calls, map[string]any{
						"id":   call.ID,
						"type": "function",
						"function": map[string]any{
							"name":      call.Name,
							"arguments": arguments,
						},
					})
				}
				entry["tool_calls"] = calls
			}
			messages = append(messages, entry)
		case RoleTool:
			messages = append(messages, map[string]any{
				"role":         "tool",
				"tool_call_id": message.ToolID,
				"content":      message.Content,
			})
		case RoleUser:
			if len(message.Images) > 0 {
				messages = append(messages, map[string]any{"role": "user", "content": encodeVisionContent(message)})
				continue
			}
			messages = append(messages, map[string]any{"role": "user", "content": message.Content})
		}
	}
	return messages
}

func encodeVisionContent(message Message) []map[string]any {
	parts := make([]map[string]any, 0, len(message.Images)+1)
	if strings.TrimSpace(message.Content) != "" {
		parts = append(parts, map[string]any{"type": "text", "text": message.Content})
	}
	for _, image := range message.Images {
		parts = append(parts, map[string]any{
			"type": "image_url",
			"image_url": map[string]any{
				"url": "data:" + image.MediaType + ";base64," + image.Data,
			},
		})
	}
	return parts
}

func encodeOpenAITools(tools []ToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema := tool.Schema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  schema,
			},
		})
	}
	return out
}

func nullable(text string) any {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	return text
}

// extraHeaders adds provider-specific headers that change routing or billing.
func extraHeaders(headers map[string]string, providerID string) {
	if providerID == "openrouter" {
		headers["HTTP-Referer"] = "https://github.com/99apps-id/termixgo"
		headers["X-Title"] = "Termixgo"
	}
}

// openAIDelta is one streamed delta. reasoning_content is DeepSeek's field,
// reasoning is OpenRouter's; both mean "thinking".
type openAIDelta struct {
	Content          string            `json:"content"`
	ReasoningContent string            `json:"reasoning_content"`
	Reasoning        string            `json:"reasoning"`
	ToolCalls        []openAIToolDelta `json:"tool_calls"`
}

func (d openAIDelta) thinking() string {
	if d.ReasoningContent != "" {
		return d.ReasoningContent
	}
	return d.Reasoning
}

type openAIToolDelta struct {
	Index    int    `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openAIChunk struct {
	Choices []struct {
		Delta        openAIDelta `json:"delta"`
		FinishReason string      `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		TotalTokens         int `json:"total_tokens"`
		PromptTokensDetails *struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
}
