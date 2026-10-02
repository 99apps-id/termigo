package provider

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
)

// antigravityClient speaks Google's Cloud Code API behind an Antigravity OAuth
// login. It is not chat-completions or the Gemini REST surface: the request is
// a Cloud Code envelope and the stream is a wrapped Gemini candidate feed.
//
// The wire shapes follow the 9router reference (open-sse/executors/
// antigravity.js): one project id, a per-connection session id, and a
// streamGenerateContent call on the daily host.
type antigravityClient struct {
	*httpClient

	mu      sync.Mutex
	project string
	// signatures remembers a functionCall's thoughtSignature so it can be
	// replayed on the next request, which Gemini 3 requires for a tool loop.
	signatures map[string]string
	sessionID  string
}

const (
	agUserAgent      = "antigravity/ide/2.11.0 darwin/arm64"
	agMaxOutputToken = 64000
)

// The onboarding endpoints are variables so tests can point them at a server.
var (
	agLoadAssistURL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
	agOnboardURL    = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser"
)

func (c *antigravityClient) Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error {
	project, err := c.ensureProject(ctx)
	if err != nil {
		return err
	}
	session := c.session()
	body := map[string]any{
		"project":   project,
		"model":     req.Model,
		"userAgent": "antigravity",
		"requestId": agRequestID(session, req.Model, len(req.Messages)),
		"request": map[string]any{
			"contents":         c.encodeContents(req),
			"sessionId":        session,
			"generationConfig": agGenerationConfig(req),
		},
	}
	request := body["request"].(map[string]any)
	if strings.TrimSpace(req.System) != "" {
		request["systemInstruction"] = map[string]any{
			"role":  "user",
			"parts": []map[string]any{{"text": req.System}},
		}
	}
	if len(req.Tools) > 0 {
		request["tools"] = []map[string]any{{"functionDeclarations": agTools(req.Tools)}}
		request["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "VALIDATED"}}
	}

	key := c.currentKey()
	headers := map[string]string{
		"Authorization":        "Bearer " + key,
		"User-Agent":           agUserAgent,
		"X-Machine-Session-Id": session,
	}
	endpoint := c.baseURL + "/v1internal:streamGenerateContent?alt=sse"
	response, err := c.post(ctx, endpoint, headers, body)
	if err != nil {
		if isAuthOrSessionError(err) {
			// Token expired or session invalidated on Google's backend: refresh token, reset session, and retry once.
			newKey := c.refreshKey()
			newSession := c.resetSession()
			headers["Authorization"] = "Bearer " + newKey
			headers["X-Machine-Session-Id"] = newSession
			reqMap := body["request"].(map[string]any)
			reqMap["sessionId"] = newSession
			body["requestId"] = agRequestID(newSession, req.Model, len(req.Messages))
			response, err = c.post(ctx, endpoint, headers, body)
		}
		// The daily host is the chat host; when it fails at the endpoint level,
		// retry once on the prod host. The check must name the daily host,
		// because "cloudcode-pa.googleapis.com" is a substring of it too.
		if err != nil && isEndpointError(err) && strings.Contains(c.baseURL, "daily-cloudcode-pa") {
			fallbackURL := "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
			response, err = c.post(ctx, fallbackURL, headers, body)
		}
		if err != nil {
			return err
		}
	}
	defer response.Body.Close()

	reader := newSSEReader(response.Body)
	usage := &cumulativeUsage{}
	emitted := false
	finish := ""
	for {
		payload, err := reader.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return wrapStreamError(c.info.Label, err)
		}
		if strings.TrimSpace(payload) == "" {
			continue
		}
		// Each event is {"response": {...}} on the daily host, but tolerate a
		// bare candidate object too.
		var envelope struct {
			Response json.RawMessage `json:"response"`
		}
		candidate := []byte(payload)
		if json.Unmarshal([]byte(payload), &envelope) == nil && len(envelope.Response) > 0 {
			candidate = envelope.Response
		}
		var chunk agResponse
		if json.Unmarshal(candidate, &chunk) != nil {
			continue
		}
		if chunk.UsageMetadata != nil {
			if step, ok := usage.step(Usage{
				PromptTokens:     chunk.UsageMetadata.PromptTokenCount,
				CompletionTokens: chunk.UsageMetadata.CandidatesTokenCount,
				TotalTokens:      chunk.UsageMetadata.TotalTokenCount,
			}); ok {
				if err := emit(StreamEvent{Type: EventUsage, Usage: &step}); err != nil {
					return err
				}
			}
		}
		if len(chunk.Candidates) == 0 {
			continue
		}
		if reason := strings.TrimSpace(chunk.Candidates[0].FinishReason); reason != "" {
			finish = reason
		}
		for _, part := range chunk.Candidates[0].Content.Parts {
			if part.FunctionCall != nil {
				emitted = true
				c.rememberSignature(part.FunctionCall.ID, part.ThoughtSignature)
				arguments, _ := json.Marshal(part.FunctionCall.Args)
				call := ToolCall{ID: part.FunctionCall.ID, Name: part.FunctionCall.Name, Arguments: string(arguments)}
				if err := emit(StreamEvent{Type: EventToolCall, ToolCall: &call}); err != nil {
					return err
				}
				continue
			}
			if part.Text == "" {
				continue
			}
			emitted = true
			kind := EventTextDelta
			if part.Thought {
				kind = EventReasoningDelta
			}
			if err := emit(StreamEvent{Type: kind, Text: part.Text}); err != nil {
				return err
			}
		}
	}
	// A candidate that ended without content for a reason other than a clean
	// stop (a safety block, a token cap, a malformed function call) is not a
	// step worth retrying blindly: the same request returns the same empty
	// answer. Surface the reason so the turn explains itself instead of
	// looping on a silent empty step.
	if !emitted && finish != "" && !strings.EqualFold(finish, "STOP") {
		return fmt.Errorf("the model ended the turn without an answer (finish reason %s)", strings.ToLower(finish))
	}
	return nil
}

// ensureProject resolves the Cloud Code project id, onboarding the account the
// first time. The id is cached for the life of the client.
func (c *antigravityClient) ensureProject(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.project != "" {
		return c.project, nil
	}
	if strings.TrimSpace(c.accountID) != "" {
		c.project = c.accountID
		return c.project, nil
	}
	metadata := map[string]any{"ideType": 9, "platform": agPlatform(), "pluginType": 2}
	raw, err := c.doJSON(ctx, agLoadAssistURL, map[string]any{"metadata": metadata})
	if err != nil {
		return "", err
	}
	var loaded struct {
		Project json.RawMessage `json:"cloudaicompanionProject"`
		Tiers   []struct {
			ID        string `json:"id"`
			IsDefault bool   `json:"isDefault"`
		} `json:"allowedTiers"`
	}
	_ = json.Unmarshal(raw, &loaded)
	project := agProjectID(loaded.Project)
	tier := "legacy-tier"
	for _, candidate := range loaded.Tiers {
		if candidate.IsDefault {
			tier = candidate.ID
			break
		}
	}
	if project == "" {
		for attempt := 0; attempt < 3 && project == ""; attempt++ {
			onboard, err := c.doJSON(ctx, agOnboardURL, map[string]any{"tierId": tier, "metadata": metadata})
			if err != nil {
				break
			}
			var parsed struct {
				Done     bool `json:"done"`
				Response struct {
					Project json.RawMessage `json:"cloudaicompanionProject"`
				} `json:"response"`
			}
			_ = json.Unmarshal(onboard, &parsed)
			project = agProjectID(parsed.Response.Project)
			if parsed.Done && project != "" {
				break
			}
			time.Sleep(2 * time.Second)
		}
	}
	if project == "" {
		project = "termixgo-" + randomHex(8)
	}
	c.project = project
	return project, nil
}

func (c *antigravityClient) doJSON(ctx context.Context, endpoint string, payload any) ([]byte, error) {
	key := c.currentKey()
	body, status, err := c.doJSONWithKey(ctx, endpoint, payload, key)
	if err == nil && status >= 200 && status < 300 {
		return body, nil
	}
	if status == http.StatusUnauthorized {
		freshKey := c.refreshKey()
		body, status, err = c.doJSONWithKey(ctx, endpoint, payload, freshKey)
		if err == nil && status >= 200 && status < 300 {
			return body, nil
		}
	}
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("%s returned %d: %s", endpoint, status, clipRunes(strings.TrimSpace(string(body)), 200))
}

func (c *antigravityClient) doJSONWithKey(ctx context.Context, endpoint string, payload any, key string) ([]byte, int, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("User-Agent", agUserAgent)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return body, response.StatusCode, nil
}

func (c *antigravityClient) session() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sessionID == "" {
		sum := sha256.Sum256([]byte(randomHex(16)))
		// Positive 63-bit integer string. Google Cloud Code requires a non-negative session ID.
		c.sessionID = fmt.Sprintf("%d", binary.BigEndian.Uint64(sum[:8])&0x7FFFFFFFFFFFFFFF)
	}
	return c.sessionID
}

func (c *antigravityClient) resetSession() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	sum := sha256.Sum256([]byte(randomHex(16)))
	c.sessionID = fmt.Sprintf("%d", binary.BigEndian.Uint64(sum[:8])&0x7FFFFFFFFFFFFFFF)
	c.signatures = map[string]string{}
	return c.sessionID
}

func (c *antigravityClient) rememberSignature(callID, signature string) {
	if callID == "" || signature == "" {
		return
	}
	c.mu.Lock()
	if c.signatures == nil {
		c.signatures = map[string]string{}
	}
	c.signatures[callID] = signature
	c.mu.Unlock()
}

func (c *antigravityClient) signatureFor(callID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.signatures[callID]
}

// encodeContents maps the shared message list to Gemini contents.
func (c *antigravityClient) encodeContents(req ChatRequest) []map[string]any {
	contents := make([]map[string]any, 0, len(req.Messages))
	for _, message := range req.Messages {
		switch message.Role {
		case RoleUser:
			parts := make([]map[string]any, 0, len(message.Images)+1)
			if strings.TrimSpace(message.Content) != "" {
				parts = append(parts, map[string]any{"text": message.Content})
			}
			for _, image := range message.Images {
				parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": image.MediaType, "data": image.Data}})
			}
			if len(parts) == 0 {
				continue
			}
			contents = append(contents, map[string]any{"role": "user", "parts": parts})
		case RoleAssistant:
			parts := make([]map[string]any, 0, len(message.ToolCalls)+1)
			if strings.TrimSpace(message.Content) != "" {
				parts = append(parts, map[string]any{"text": message.Content})
			}
			for _, call := range message.ToolCalls {
				args := map[string]any{}
				_ = json.Unmarshal([]byte(call.Arguments), &args)
				part := map[string]any{"functionCall": map[string]any{"id": call.ID, "name": call.Name, "args": args}}
				if signature := c.signatureFor(call.ID); signature != "" {
					part["thoughtSignature"] = signature
				}
				parts = append(parts, part)
			}
			if len(parts) == 0 {
				continue
			}
			contents = append(contents, map[string]any{"role": "model", "parts": parts})
		case RoleTool:
			// Gemini answers a functionCall with a functionResponse on a user turn.
			contents = append(contents, map[string]any{"role": "user", "parts": []map[string]any{{
				"functionResponse": map[string]any{
					"id":       message.ToolID,
					"name":     message.Name,
					"response": map[string]any{"result": message.Content},
				},
			}}})
		}
	}
	return contents
}

func agGenerationConfig(req ChatRequest) map[string]any {
	config := map[string]any{}
	if req.Temperature != nil {
		config["temperature"] = *req.Temperature
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 || maxTokens > agMaxOutputToken {
		maxTokens = agMaxOutputToken
	}
	config["maxOutputTokens"] = maxTokens
	// Gemini 3 models cannot disable thinking; ask for a thought summary so the
	// transcript shows the reasoning rather than dropping it.
	config["thinkingConfig"] = map[string]any{"thinkingLevel": "medium", "includeThoughts": true}
	return config
}

func agTools(tools []ToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema := cleanAntigravitySchema(tool.Schema)
		out = append(out, map[string]any{
			"name":        sanitizeFunctionName(tool.Name),
			"description": tool.Description,
			"parameters":  schema,
		})
	}
	return out
}

// cleanAntigravitySchema strips JSON Schema keywords Gemini rejects and makes
// sure the object carries a type and, for an empty object, a reason field.
func cleanAntigravitySchema(schema map[string]any) map[string]any {
	if schema == nil {
		return map[string]any{"type": "object", "properties": map[string]any{"reason": map[string]any{"type": "string"}}, "required": []string{"reason"}}
	}
	cleaned := stripSchemaKeys(schema).(map[string]any)
	if cleaned["type"] == nil {
		cleaned["type"] = "object"
	}
	properties, _ := cleaned["properties"].(map[string]any)
	if cleaned["type"] == "object" && len(properties) == 0 {
		cleaned["properties"] = map[string]any{"reason": map[string]any{"type": "string"}}
		cleaned["required"] = []string{"reason"}
	}
	// A required name without a matching property is rejected with
	// "property is not defined", which MCP servers emit.
	return pruneUndefinedRequired(cleaned).(map[string]any)
}

// geminiUnsupportedKeys are JSON Schema keywords the Gemini function-declaration
// schema rejects with an "Unknown name" 400. MCP servers emit schemas with
// keywords like propertyNames, so every path that sends tools to Gemini must
// drop them. anyOf/oneOf/allOf/not are listed because Gemini cannot express
// them in a function schema.
var geminiUnsupportedKeys = map[string]bool{
	"$schema": true, "$id": true, "$ref": true, "$defs": true, "$comment": true,
	"definitions": true, "additionalProperties": true, "propertyNames": true,
	"patternProperties": true, "unevaluatedProperties": true, "unevaluatedItems": true,
	"dependentRequired": true, "dependentSchemas": true,
	"default": true, "examples": true, "title": true, "optional": true,
	"deprecated": true, "readOnly": true, "writeOnly": true,
	"uniqueItems": true, "const": true, "oneOf": true, "anyOf": true, "allOf": true, "not": true,
	"if": true, "then": true, "else": true,
	"contentEncoding": true, "contentMediaType": true, "contentSchema": true,
}

var antigravityUnsupportedKeys = geminiUnsupportedKeys

func stripSchemaKeys(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, entry := range typed {
			if antigravityUnsupportedKeys[key] || strings.HasPrefix(key, "x-") {
				continue
			}
			// Inside "properties" the keys are property names, not schema
			// keywords. A tool is free to name a property "title" or "required";
			// filtering those names deleted the property and then left a
			// dangling required entry, which Gemini rejects.
			if key == "properties" {
				if properties, ok := entry.(map[string]any); ok {
					cleaned := make(map[string]any, len(properties))
					for name, property := range properties {
						cleaned[name] = stripSchemaKeys(property)
					}
					out[key] = cleaned
					continue
				}
			}
			// JSON Schema allows a type union, for example ["string","null"],
			// but the Gemini Schema proto wants one type string plus nullable.
			// A list there answers "Proto field is not repeating".
			if key == "type" {
				if chosen, nullable, ok := reduceTypeList(entry); ok {
					out["type"] = chosen
					if nullable {
						out["nullable"] = true
					}
					continue
				}
			}
			out[key] = stripSchemaKeys(entry)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, stripSchemaKeys(entry))
		}
		return out
	default:
		return value
	}
}

// pruneUndefinedRequired removes every name from a "required" list that has no
// sibling property. The Gemini function schema validates required against
// properties and answers "property is not defined" otherwise, which both
// hand-written and MCP-supplied schemas trip over.
func pruneUndefinedRequired(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, entry := range typed {
			out[key] = pruneUndefinedRequired(entry)
		}
		if required, ok := out["required"]; ok {
			properties, _ := out["properties"].(map[string]any)
			if filtered, keep := definedRequired(required, properties); keep {
				out["required"] = filtered
			} else {
				delete(out, "required")
			}
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, entry := range typed {
			out[index] = pruneUndefinedRequired(entry)
		}
		return out
	default:
		return value
	}
}

// definedRequired keeps the required names that name a real property, reporting
// whether any survived.
func definedRequired(required any, properties map[string]any) (any, bool) {
	switch names := required.(type) {
	case []string:
		kept := make([]string, 0, len(names))
		for _, name := range names {
			if _, present := properties[name]; present {
				kept = append(kept, name)
			}
		}
		if len(kept) == 0 {
			return nil, false
		}
		return kept, true
	case []any:
		kept := make([]any, 0, len(names))
		for _, entry := range names {
			if text, ok := entry.(string); ok {
				if _, present := properties[text]; present {
					kept = append(kept, text)
				}
			}
		}
		if len(kept) == 0 {
			return nil, false
		}
		return kept, true
	default:
		return nil, false
	}
}

// reduceTypeList collapses a JSON Schema type union to a single Gemini type,
// reporting whether "null" was one of the members so the caller can set
// nullable. ok is false when the value is not a list, which means it already is
// a plain type string.
func reduceTypeList(value any) (chosen string, nullable bool, ok bool) {
	var names []string
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if name, isString := item.(string); isString {
				names = append(names, name)
			}
		}
	case []string:
		names = typed
	default:
		return "", false, false
	}
	if len(names) == 0 {
		return "", false, false
	}
	for _, name := range names {
		if strings.EqualFold(name, "null") {
			nullable = true
			continue
		}
		if chosen == "" {
			chosen = name
		}
	}
	if chosen == "" {
		chosen = "string"
	}
	return chosen, nullable, true
}

func sanitizeFunctionName(name string) string {
	var builder strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '.', r == ':', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteRune('_')
		}
	}
	clean := builder.String()
	if clean == "" {
		return "_unknown"
	}
	if clean[0] >= '0' && clean[0] <= '9' {
		clean = "_" + clean
	}
	if len(clean) > 64 {
		clean = clean[:64]
	}
	return clean
}

func agPlatform() int {
	switch runtime.GOOS {
	case "windows":
		return 5
	case "darwin":
		return 2
	default:
		return 1
	}
}

func agProjectID(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		trimmed := strings.TrimSpace(text)
		return strings.TrimPrefix(trimmed, "projects/")
	}
	var object struct {
		ID        string `json:"id"`
		ProjectID string `json:"projectId"`
		Project   string `json:"project"`
		Name      string `json:"name"`
	}
	if json.Unmarshal(raw, &object) == nil {
		for _, val := range []string{object.ID, object.ProjectID, object.Project, object.Name} {
			trimmed := strings.TrimSpace(val)
			if trimmed != "" {
				return strings.TrimPrefix(trimmed, "projects/")
			}
		}
	}
	return ""
}

func isAuthOrSessionError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "401") ||
		strings.Contains(msg, "unauthenticated") ||
		strings.Contains(msg, "unauthorized") ||
		strings.Contains(msg, "session") ||
		strings.Contains(msg, "token") ||
		strings.Contains(msg, "expired")
}

func isEndpointError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "404") ||
		strings.Contains(msg, "429") ||
		strings.Contains(msg, "502") ||
		strings.Contains(msg, "503") ||
		strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host")
}

func agRequestID(session, model string, messageCount int) string {
	if messageCount < 1 {
		messageCount = 1
	}
	step := messageCount*2 - 1
	if step < 1 {
		step = 1
	}
	return fmt.Sprintf("agent/%s/%d/%s/%d", randomHex(16), time.Now().UnixMilli(), randomHex(16), step)
}

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(buffer)
}

type agResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text             string `json:"text"`
				Thought          bool   `json:"thought"`
				ThoughtSignature string `json:"thoughtSignature"`
				FunctionCall     *struct {
					ID   string         `json:"id"`
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
		ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
}
