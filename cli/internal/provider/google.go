package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// googleClient speaks the Gemini streamGenerateContent protocol.
type googleClient struct{ *httpClient }

func (c *googleClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	payload := map[string]any{
		"contents": encodeGoogleContents(req.Messages),
	}
	if strings.TrimSpace(req.System) != "" {
		payload["systemInstruction"] = map[string]any{
			"parts": []map[string]any{{"text": req.System}},
		}
	}
	if len(req.Tools) > 0 {
		payload["tools"] = []map[string]any{{"functionDeclarations": encodeGoogleTools(req.Tools)}}
	}
	generation := map[string]any{}
	if req.Temperature != nil {
		generation["temperature"] = *req.Temperature
	}
	if supportsThoughts(req.Model) {
		generation["thinkingConfig"] = map[string]any{"includeThoughts": true}
	}
	if req.MaxTokens > 0 {
		generation["maxOutputTokens"] = req.MaxTokens
	}
	if len(generation) > 0 {
		payload["generationConfig"] = generation
	}

	endpoint := fmt.Sprintf("%s/v1beta/%s:streamGenerateContent?alt=sse&key=%s",
		c.baseURL, googleModelPath(req.Model), url.QueryEscape(c.apiKey))
	response, err := c.post(ctx, endpoint, nil, payload)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	reader := newSSEReader(response.Body)
	toolIndex := 0
	usage := &cumulativeUsage{}
	for {
		payload, err := reader.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return wrapStreamError("Google", err)
		}
		if payload == "" {
			continue
		}
		var chunk googleChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if chunk.UsageMetadata != nil {
			current := Usage{
				PromptTokens:     chunk.UsageMetadata.PromptTokenCount,
				CompletionTokens: chunk.UsageMetadata.CandidatesTokenCount,
				TotalTokens:      chunk.UsageMetadata.TotalTokenCount,
				CacheReadTokens:  chunk.UsageMetadata.CachedContentTokenCount,
			}
			if step, ok := usage.step(current); ok {
				if err := emit(StreamEvent{Type: EventUsage, Usage: &step}); err != nil {
					return err
				}
			}
		}
		for _, candidate := range chunk.Candidates {
			if candidate.Content == nil {
				continue
			}
			for _, part := range candidate.Content.Parts {
				if part.FunctionCall != nil {
					arguments := "{}"
					if len(part.FunctionCall.Args) > 0 {
						if encoded, err := json.Marshal(part.FunctionCall.Args); err == nil {
							arguments = string(encoded)
						}
					}
					call := ToolCall{
						ID:        fmt.Sprintf("call_%d", toolIndex),
						Name:      part.FunctionCall.Name,
						Arguments: arguments,
					}
					toolIndex++
					if err := emit(StreamEvent{Type: EventToolCall, ToolCall: &call}); err != nil {
						return err
					}
					continue
				}
				if part.Text == "" {
					continue
				}
				kind := EventTextDelta
				if part.Thought {
					kind = EventReasoningDelta
				}
				if err := emit(StreamEvent{Type: kind, Text: part.Text}); err != nil {
					return err
				}
			}
			if candidate.FinishReason == "SAFETY" || candidate.FinishReason == "BLOCKLIST" || candidate.FinishReason == "PROHIBITED_CONTENT" {
				return fmt.Errorf("the Google endpoint blocked the response (%s)", candidate.FinishReason)
			}
		}
	}
	return nil
}

// googleModelPath accepts either "gemini-2.5-pro" or "models/gemini-2.5-pro".
func googleModelPath(model string) string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(model), "models/")
	return "models/" + trimmed
}

// supportsThoughts reports whether a model accepts the includeThoughts flag;
// sending it to an older model is a hard request error.
func supportsThoughts(model string) bool {
	return strings.Contains(model, "2.5") || strings.Contains(model, "gemini-3") || strings.Contains(model, "3-pro") || strings.Contains(model, "3-flash")
}

func encodeGoogleTools(tools []ToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		entry := map[string]any{"name": tool.Name, "description": tool.Description}
		if tool.Schema != nil {
			entry["parameters"] = sanitizeGoogleSchema(tool.Schema)
		}
		out = append(out, entry)
	}
	return out
}

// sanitizeGoogleSchema drops JSON Schema keywords the Gemini API rejects. It
// shares stripSchemaKeys with Antigravity, which keeps property names intact
// and prunes a required name that has no property.
func sanitizeGoogleSchema(schema map[string]any) map[string]any {
	out := stripSchemaKeys(schema).(map[string]any)
	if _, ok := out["type"]; !ok {
		out["type"] = "object"
	}
	return pruneUndefinedRequired(out).(map[string]any)
}

// encodeGoogleContents builds the contents array, matching tool results by
// function name and merging consecutive results into one user turn.
func encodeGoogleContents(messages []Message) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	for index := 0; index < len(messages); index++ {
		message := messages[index]
		switch message.Role {
		case RoleUser:
			out = append(out, map[string]any{"role": "user", "parts": googleUserParts(message)})
		case RoleAssistant:
			parts := make([]map[string]any, 0, len(message.ToolCalls)+1)
			if strings.TrimSpace(message.Content) != "" {
				parts = append(parts, map[string]any{"text": message.Content})
			}
			for _, call := range message.ToolCalls {
				args, err := decodeArguments(call.Arguments)
				if err != nil {
					args = map[string]any{}
				}
				parts = append(parts, map[string]any{"functionCall": map[string]any{"name": call.Name, "args": args}})
			}
			if len(parts) == 0 {
				parts = append(parts, map[string]any{"text": ""})
			}
			out = append(out, map[string]any{"role": "model", "parts": parts})
		case RoleTool:
			parts := []map[string]any{googleFunctionResponse(message)}
			for index+1 < len(messages) && messages[index+1].Role == RoleTool {
				index++
				parts = append(parts, googleFunctionResponse(messages[index]))
			}
			out = append(out, map[string]any{"role": "user", "parts": parts})
		}
	}
	return out
}

func googleUserParts(message Message) []map[string]any {
	parts := make([]map[string]any, 0, len(message.Images)+1)
	if strings.TrimSpace(message.Content) != "" {
		parts = append(parts, map[string]any{"text": message.Content})
	}
	for _, image := range message.Images {
		parts = append(parts, map[string]any{
			"inlineData": map[string]any{"mimeType": image.MediaType, "data": image.Data},
		})
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{"text": ""})
	}
	return parts
}

func googleFunctionResponse(message Message) map[string]any {
	content := message.Content
	if strings.TrimSpace(content) == "" {
		content = "(no output)"
	}
	return map[string]any{
		"functionResponse": map[string]any{
			"name":     message.Name,
			"response": map[string]any{"result": content},
		},
	}
}

type googleChunk struct {
	Candidates []struct {
		Content *struct {
			Parts []struct {
				Text         string `json:"text"`
				Thought      bool   `json:"thought"`
				FunctionCall *struct {
					Name string         `json:"name"`
					Args map[string]any `json:"args"`
				} `json:"functionCall"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *struct {
		PromptTokenCount        int `json:"promptTokenCount"`
		CandidatesTokenCount    int `json:"candidatesTokenCount"`
		TotalTokenCount         int `json:"totalTokenCount"`
		CachedContentTokenCount int `json:"cachedContentTokenCount"`
	} `json:"usageMetadata"`
}
