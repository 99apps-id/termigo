package provider

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// copilotClient routes completions to GitHub Copilot's chat or messages backend.
type copilotClient struct {
	*httpClient
}

func (c *copilotClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	key := c.currentKey()
	isClaude := strings.Contains(strings.ToLower(req.Model), "claude")

	reqID := fmt.Sprintf("copilot-%s", deriveSessionID(key))
	headers := map[string]string{
		"Authorization":                       "Bearer " + key,
		"Content-Type":                        "application/json",
		"copilot-integration-id":              "vscode-chat",
		"editor-version":                      "vscode/1.110.0",
		"editor-plugin-version":               "copilot-chat/0.38.0",
		"user-agent":                          "GitHubCopilotChat/0.38.0",
		"openai-intent":                       "conversation-panel",
		"x-github-api-version":                "2025-04-01",
		"x-request-id":                        reqID,
		"x-vscode-user-agent-library-version": "electron-fetch",
		"X-Initiator":                         "user",
		"session_id":                          c.SessionID(),
	}

	if isClaude {
		headers["anthropic-version"] = "2023-06-01"
		anthropicCli := &anthropicClient{httpClient: c.httpClient}
		url := c.baseURL + "/v1/messages"
		maxTokens := req.MaxTokens
		if maxTokens <= 0 {
			maxTokens = 8192
		}
		payload := map[string]any{
			"model":      req.Model,
			"max_tokens": maxTokens,
			"stream":     true,
			"messages":   encodeAnthropicMessages(req.Messages),
		}
		if strings.TrimSpace(req.System) != "" {
			payload["system"] = req.System
		}
		if req.Temperature != nil {
			payload["temperature"] = *req.Temperature
		}
		if len(req.Tools) > 0 {
			payload["tools"] = encodeAnthropicTools(req.Tools)
		}
		return anthropicCli.streamWithURL(ctx, url, headers, payload, emit, nil)
	}

	// Some Copilot models are not served by /chat/completions and answer a 400
	// that names the /chat/completions endpoint. Route those to /responses once
	// seen, and escalate on the specific error the first time.
	if copilotResponsesModel(req.Model) {
		return c.streamResponses(ctx, headers, req, emit)
	}
	openAICli := &openAIClient{httpClient: c.httpClient}
	payload := map[string]any{
		"model":    req.Model,
		"stream":   true,
		"messages": openAICli.encodeMessages(req),
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if len(req.Tools) > 0 {
		payload["tools"] = encodeOpenAITools(req.Tools)
		payload["tool_choice"] = "auto"
	}
	err := openAICli.streamWithURL(ctx, c.baseURL+"/chat/completions", headers, payload, emit)
	if err != nil && copilotEscalate(err) && copilotSupportsResponses(req.Model) {
		copilotMarkResponses(req.Model)
		return c.streamResponses(ctx, headers, req, emit)
	}
	return err
}

// streamResponses sends the request to Copilot's OpenAI Responses endpoint,
// which serves the models /chat/completions rejects.
func (c *copilotClient) streamResponses(ctx context.Context, headers map[string]string, req ChatRequest, emit func(StreamEvent) error) error {
	payload := map[string]any{
		"model":  req.Model,
		"stream": true,
		"store":  false,
		"input":  encodeResponsesInput(req),
	}
	if system := strings.TrimSpace(req.System); system != "" {
		payload["instructions"] = system
	}
	if tools := encodeResponsesTools(req.Tools); len(tools) > 0 {
		payload["tools"] = tools
		payload["tool_choice"] = "auto"
	}
	response, err := c.post(ctx, c.baseURL+"/responses", headers, payload)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return decodeResponsesStream(c.info.Label, response.Body, emit)
}

// copilotResponsesModels remembers the models a Copilot account has told us to
// serve through /responses, so the failed /chat/completions attempt happens
// only once per model for the life of the process.
var copilotResponsesModels sync.Map

func copilotResponsesModel(model string) bool {
	_, ok := copilotResponsesModels.Load(strings.ToLower(strings.TrimSpace(model)))
	return ok
}

func copilotMarkResponses(model string) {
	copilotResponsesModels.Store(strings.ToLower(strings.TrimSpace(model)), true)
}

// copilotSupportsResponses mirrors the reference: Copilot's Responses endpoint
// does not serve Gemini or Claude models, so only the error-driven escalation
// is guarded by it (Claude is handled before this point).
func copilotSupportsResponses(model string) bool {
	m := strings.ToLower(model)
	return !strings.Contains(m, "gemini") && !strings.Contains(m, "claude")
}

// copilotEscalate reports whether a /chat/completions error is the model saying
// it must use /responses.
func copilotEscalate(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "not accessible via the /chat/completions endpoint") ||
		strings.Contains(message, "the requested model is not supported")
}
