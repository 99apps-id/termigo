package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// codexCLIVersion is the Codex CLI release whose identity the ChatGPT backend
// expects. It gates access to the newer models, so it is sent in both the
// User-Agent and the version header.
const codexCLIVersion = "0.159.0"

// codexClient speaks the Responses API served by the ChatGPT backend for a
// Codex login. It is not chat-completions: the request carries input items and
// the stream is a typed event feed, so it needs its own encoder and decoder.
type codexClient struct{ *httpClient }

func (c *codexClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	input := encodeResponsesInput(req)
	instructions := strings.TrimSpace(req.System)
	var tools []map[string]any
	if len(req.Tools) > 0 {
		tools = encodeResponsesTools(req.Tools)
	}
	payload := map[string]any{
		"model":  req.Model,
		"stream": true,
		"store":  false,
		"input":  input,
	}
	if instructions != "" {
		payload["instructions"] = instructions
	}
	if len(tools) > 0 {
		payload["tools"] = tools
		payload["tool_choice"] = "auto"
	}
	if isCodexResponsesLiteModel(req.Model) {
		applyResponsesLite(payload, input, tools, instructions)
	}

	key := c.currentKey()
	headers := map[string]string{
		"Authorization": "Bearer " + key,
		"originator":    "codex_cli_rs",
		"User-Agent":    "codex_cli_rs/" + codexCLIVersion,
		"version":       codexCLIVersion,
		"session_id":    c.SessionID(),
	}
	if strings.TrimSpace(c.accountID) != "" {
		headers["ChatGPT-Account-ID"] = c.accountID
	}

	response, err := c.post(ctx, c.baseURL+"/responses", headers, payload)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return decodeResponsesStream(c.info.Label, response.Body, emit)
}

// decodeResponsesStream turns the OpenAI Responses event feed into StreamEvents.
// The Codex client and the Copilot /responses route share it.
func decodeResponsesStream(label string, body io.Reader, emit func(StreamEvent) error) error {
	reader := newSSEReader(body)
	usage := &cumulativeUsage{}
	for {
		payload, err := reader.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return wrapStreamError(label, err)
		}
		if strings.TrimSpace(payload) == "" {
			continue
		}
		var event responsesEvent
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		switch event.Type {
		case "response.output_text.delta":
			if event.Delta != "" {
				if err := emit(StreamEvent{Type: EventTextDelta, Text: event.Delta}); err != nil {
					return err
				}
			}
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			if event.Delta != "" {
				if err := emit(StreamEvent{Type: EventReasoningDelta, Text: event.Delta}); err != nil {
					return err
				}
			}
		case "response.output_item.done":
			if event.Item != nil && event.Item.Type == "function_call" && event.Item.Name != "" {
				call := ToolCall{ID: event.Item.CallID, Name: event.Item.Name, Arguments: event.Item.Arguments}
				if err := emit(StreamEvent{Type: EventToolCall, ToolCall: &call}); err != nil {
					return err
				}
			}
		case "response.completed":
			if event.Response != nil && event.Response.Usage != nil {
				raw := event.Response.Usage
				if step, ok := usage.step(Usage{
					PromptTokens:     raw.InputTokens,
					CompletionTokens: raw.OutputTokens,
					TotalTokens:      raw.TotalTokens,
				}); ok {
					if err := emit(StreamEvent{Type: EventUsage, Usage: &step}); err != nil {
						return err
					}
				}
			}
		case "response.failed", "error":
			return wrapStreamError(label, fmt.Errorf("the Responses backend reported a failure: %s", event.message()))
		}
	}
	return nil
}

func encodeResponsesInput(req ChatRequest) []map[string]any {
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
			if strings.TrimSpace(message.Content) != "" {
				items = append(items, map[string]any{
					"type":    "message",
					"role":    "assistant",
					"content": []map[string]any{{"type": "output_text", "text": message.Content}},
				})
			}
			for _, call := range message.ToolCalls {
				arguments := call.Arguments
				if strings.TrimSpace(arguments) == "" {
					arguments = "{}"
				}
				items = append(items, map[string]any{
					"type":      "function_call",
					"call_id":   call.ID,
					"name":      call.Name,
					"arguments": arguments,
				})
			}
		case RoleTool:
			items = append(items, map[string]any{
				"type":    "function_call_output",
				"call_id": message.ToolID,
				"output":  message.Content,
			})
		}
	}
	return items
}

func responsesUserContent(message Message) []map[string]any {
	parts := make([]map[string]any, 0, len(message.Images)+1)
	if strings.TrimSpace(message.Content) != "" {
		parts = append(parts, map[string]any{"type": "input_text", "text": message.Content})
	}
	for _, image := range message.Images {
		parts = append(parts, map[string]any{
			"type":      "input_image",
			"image_url": "data:" + image.MediaType + ";base64," + image.Data,
		})
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{"type": "input_text", "text": ""})
	}
	return parts
}

func encodeResponsesTools(tools []ToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema := tool.Schema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"type":        "function",
			"name":        tool.Name,
			"description": tool.Description,
			"parameters":  schema,
		})
	}
	return out
}

// applyResponsesLite rewrites a request for the responses-lite models. They
// carry tools and instructions as input prefix items and reject the top-level
// tools and instructions fields; the reference executor does the same.
func applyResponsesLite(payload map[string]any, input []map[string]any, tools []map[string]any, instructions string) {
	if tools == nil {
		tools = []map[string]any{}
	}
	prefix := []map[string]any{{"type": "additional_tools", "role": "developer", "tools": tools}}
	if instructions != "" {
		prefix = append(prefix, map[string]any{
			"type":    "message",
			"role":    "developer",
			"content": []map[string]any{{"type": "input_text", "text": instructions}},
		})
	}
	payload["input"] = append(prefix, input...)
	delete(payload, "instructions")
	delete(payload, "tools")
	payload["tool_choice"] = "auto"
	payload["parallel_tool_calls"] = false
	payload["reasoning"] = map[string]any{"effort": "medium", "context": "all_turns"}
	payload["include"] = []string{"reasoning.encrypted_content"}
}

// responsesEvent is the subset of the event feed the client needs.
type responsesEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Item *struct {
		Type      string `json:"type"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"item"`
	Response *struct {
		Usage *struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
			TotalTokens  int `json:"total_tokens"`
		} `json:"usage"`
	} `json:"response"`
}

func (e responsesEvent) message() string {
	if e.Error != nil && strings.TrimSpace(e.Error.Message) != "" {
		return e.Error.Message
	}
	return e.Type
}

func isCodexResponsesLiteModel(model string) bool {
	m := strings.ToLower(model)
	return strings.Contains(m, "gpt-6.1-sol") || strings.Contains(m, "gpt-6-sol") || strings.Contains(m, "gpt-6-luna")
}
