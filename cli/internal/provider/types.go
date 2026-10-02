// Package provider talks to the BYOK model APIs over their streaming HTTP
// endpoints. One Client per provider kind keeps the wire differences
// (OpenAI-compatible, Anthropic, Google) in one place each.
package provider

import (
	"context"
	"fmt"
	"strings"
)

// Role is a message author.
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// Image is an inline image attachment for vision models.
type Image struct {
	MediaType string
	Data      string // base64, no data: prefix
}

// ToolCall is one function invocation requested by the model.
type ToolCall struct {
	ID        string
	Name      string
	Arguments string // raw JSON object
}

// Message is one turn. The flat shape covers every provider, which keeps
// session storage and compaction simple.
type Message struct {
	Role      Role
	Content   string
	Reasoning string
	ToolCalls []ToolCall
	// ToolID correlates a tool result with the assistant call (OpenAI,
	// Anthropic). Name is the tool name (Google matches results by name).
	ToolID string
	Name   string
	Images []Image
}

// ToolDef is a tool offered to the model. Schema is a JSON Schema object.
type ToolDef struct {
	Name        string
	Description string
	Schema      map[string]any
}

// Usage is the token accounting a provider reports.
type Usage struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	CacheReadTokens  int
	CacheWriteTokens int
}

// Add sums two usage reports.
func (u Usage) Add(other Usage) Usage {
	return Usage{
		PromptTokens:     u.PromptTokens + other.PromptTokens,
		CompletionTokens: u.CompletionTokens + other.CompletionTokens,
		TotalTokens:      u.TotalTokens + other.TotalTokens,
		CacheReadTokens:  u.CacheReadTokens + other.CacheReadTokens,
		CacheWriteTokens: u.CacheWriteTokens + other.CacheWriteTokens,
	}
}

// ChatRequest is one streaming completion request.
type ChatRequest struct {
	Model       string
	System      string
	SystemParts []string // optional structured system blocks for explicit prompt cache control
	Messages    []Message
	Tools       []ToolDef
	Temperature *float64
	MaxTokens   int
}

// StreamEventType discriminates the chunks a client emits.
type StreamEventType string

const (
	// EventTextDelta carries an answer fragment.
	EventTextDelta StreamEventType = "text-delta"
	// EventReasoningDelta carries a thinking fragment.
	EventReasoningDelta StreamEventType = "reasoning-delta"
	// EventToolCall carries a fully accumulated tool call.
	EventToolCall StreamEventType = "tool-call"
	// EventUsage carries token accounting for the step.
	EventUsage StreamEventType = "usage"
)

// StreamEvent is one chunk of a streaming completion.
type StreamEvent struct {
	Type     StreamEventType
	Text     string
	ToolCall *ToolCall
	Usage    *Usage
}

// Client streams one provider.
type Client interface {
	// ID is the provider id.
	ID() string
	// Stream runs one completion, calling emit for every chunk. emit
	// returning an error aborts the stream.
	Stream(ctx context.Context, req ChatRequest, emit func(StreamEvent) error) error
}

// KeyResolver returns the API key for a provider, or "" when none is set.
type KeyResolver func(provider string) string

// NewClient builds the client for a provider id. baseURL overrides the
// registry default; an empty value uses the default.
func NewClient(id, baseURL string, resolveKey KeyResolver) (Client, error) {
	info, ok := ByID(id)
	if !ok {
		return nil, fmt.Errorf("unknown provider %q", id)
	}
	endpoint := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if endpoint == "" {
		endpoint = DefaultBaseURL(id)
	}
	if endpoint == "" {
		return nil, fmt.Errorf("provider %q needs a base URL; set it with /setup or config.baseUrls", info.Label)
	}
	key := ""
	if resolveKey != nil {
		key = strings.TrimSpace(resolveKey(id))
	}
	if info.NeedsKey && key == "" {
		if info.OAuth {
			return nil, fmt.Errorf("%s needs a login; run 'termixgo login %s'", info.Label, id)
		}
		return nil, fmt.Errorf("no API key for %s; run /setup to add one", info.Label)
	}
	client, err := newHTTPClient(info, endpoint, key)
	if err != nil {
		return nil, err
	}
	if setter, ok := client.(interface{ SetKeyResolver(KeyResolver) }); ok {
		setter.SetKeyResolver(resolveKey)
	}
	return client, nil
}
