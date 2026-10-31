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
	// The reasoning controls travel as one object, the shape the reference
	// client sends: the effort level, plus the summary request that makes
	// the model's thinking stream back as summary deltas. Without the
	// summary a reasoning step can arrive with no visible output at all and
	// read as an idle step to the agent loop. The encrypted-content include
	// is what lets the next step hand this step's reasoning items back,
	// which a store: false backend cannot fetch on its own. A lite model
	// is rewritten by applyResponsesLite instead, in its own shape.
	if isCodexResponsesLiteModel(req.Model) {
		applyResponsesLite(payload, input, tools, instructions, req.Effort)
	} else {
		reasoning := map[string]any{"summary": "auto"}
		if effort := strings.TrimSpace(req.Effort); effort != "" {
			reasoning["effort"] = effort
		}
		payload["reasoning"] = reasoning
		payload["include"] = []string{"reasoning.encrypted_content"}
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
			// A reasoning item is kept whole: with store: false the backend
			// cannot look its own reasoning back up, so the loop stores the
			// item and the encoder hands it back on the next step.
			if event.Item != nil && event.Item.Type == "reasoning" {
				item := ReasoningItem{ID: event.Item.ID, EncryptedContent: event.Item.EncryptedContent}
				for _, part := range event.Item.Summary {
					item.Summary = append(item.Summary, part.Text)
				}
				if err := emit(StreamEvent{Type: EventReasoningItem, ReasoningItem: &item}); err != nil {
					return err
				}
			}
			if event.Item != nil && event.Item.Type == "function_call" && event.Item.Name != "" {
				call := ToolCall{ID: event.Item.CallID, Name: event.Item.Name, Arguments: event.Item.Arguments}
				if err := emit(StreamEvent{Type: EventToolCall, ToolCall: &call}); err != nil {
					return err
				}
			}
		case "response.completed", "response.incomplete":
			// An incomplete response still bills, so its usage is harvested
			// like a completed one; but it is not a finished step. It means
			// the backend cut the generation off. A cut at the output
			// ceiling (max_output_tokens) is reported as an EventIncomplete
			// after the usage so the loop can continue the truncated step
			// from its partial output; any other reason (a content filter)
			// still ends the stream in an error naming the reason instead
			// of looking like a model that silently produced nothing,
			// which the agent loop would count as an idle step.
			if event.Response != nil && event.Response.Usage != nil {
				raw := event.Response.Usage
				stepUsage := Usage{
					PromptTokens:     raw.InputTokens,
					CompletionTokens: raw.OutputTokens,
					TotalTokens:      raw.TotalTokens,
				}
				if raw.OutputTokensDetails != nil {
					stepUsage.ReasoningTokens = raw.OutputTokensDetails.ReasoningTokens
				}
				if step, ok := usage.step(stepUsage); ok {
					if err := emit(StreamEvent{Type: EventUsage, Usage: &step}); err != nil {
						return err
					}
				}
			}
			if event.Type == "response.incomplete" {
				reason := "unspecified"
				if event.Response != nil && event.Response.IncompleteDetails != nil && event.Response.IncompleteDetails.Reason != "" {
					reason = event.Response.IncompleteDetails.Reason
				}
				if reason == "max_output_tokens" {
					// The backend's own per-response output ceiling cut
					// the generation; neither client sets that ceiling, so
					// a reasoning-heavy step can hit it on a healthy run.
					// The partial step stays valid: report it and let the
					// loop continue from what arrived instead of failing
					// the whole run.
					if err := emit(StreamEvent{Type: EventIncomplete, IncompleteReason: reason}); err != nil {
						return err
					}
				} else {
					return wrapStreamError(label, fmt.Errorf("the Responses backend ended the response incomplete (%s) before the step finished", reason))
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
			// The step's reasoning items go back before its words and
			// calls: they are the thought that produced them, and a
			// stateless backend has no other way to recover it.
			for _, item := range message.ReasoningItems {
				items = append(items, reasoningItemInput(item))
			}
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

// reasoningItemInput renders a stored reasoning item back into a Responses
// input item, in the shape the backend issued it: id and encrypted content
// are what let it pick the thought up again, the summary rides along as it
// originally did.
func reasoningItemInput(item ReasoningItem) map[string]any {
	out := map[string]any{"type": "reasoning", "encrypted_content": item.EncryptedContent}
	if item.ID != "" {
		out["id"] = item.ID
	}
	if len(item.Summary) > 0 {
		summary := make([]map[string]any, 0, len(item.Summary))
		for _, text := range item.Summary {
			summary = append(summary, map[string]any{"type": "summary_text", "text": text})
		}
		out["summary"] = summary
	}
	return out
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
func applyResponsesLite(payload map[string]any, input []map[string]any, tools []map[string]any, instructions string, effort string) {
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
	// The level defaults to medium, the level these models were tuned
	// against, until the operator asks for another.
	mapped := strings.TrimSpace(effort)
	if mapped == "" {
		mapped = "medium"
	}
	payload["reasoning"] = map[string]any{"effort": mapped, "context": "all_turns", "summary": "auto"}
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
		ID               string `json:"id"`
		Type             string `json:"type"`
		CallID           string `json:"call_id"`
		Name             string `json:"name"`
		Arguments        string `json:"arguments"`
		EncryptedContent string `json:"encrypted_content"`
		Summary          []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"summary"`
	} `json:"item"`
	Response *struct {
		Usage *struct {
			InputTokens         int `json:"input_tokens"`
			OutputTokens        int `json:"output_tokens"`
			TotalTokens         int `json:"total_tokens"`
			OutputTokensDetails *struct {
				ReasoningTokens int `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
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
