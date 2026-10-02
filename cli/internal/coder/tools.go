package coder

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

// Result is what a tool returns.
type Result struct {
	// Output is the text sent back to the model.
	Output string
	// Display overrides the past-tense label detail in the UI.
	Display string
	// IsError marks the output as a failure.
	IsError bool
	// Images, when set, are attached to the conversation so a vision model can
	// see them. read_image is the only producer.
	Images []provider.Image
}

// Tool is one capability offered to the model.
type Tool interface {
	Name() string
	Aliases() []string
	Description() string
	Schema() map[string]any
	// Mutating reports whether the tool can change state, which is what
	// makes it subject to the approval policy.
	Mutating() bool
	// Risk classifies the mutation.
	Risk() Risk
	// Label is the present-tense phrase shown when the call starts.
	Label(args map[string]any) string
	// DoneLabel is the past-tense phrase shown when it finishes.
	DoneLabel(args map[string]any) string
	Run(ctx context.Context, env *Env, args map[string]any) (Result, error)
}

// Env is everything a tool needs from the running process.
type Env struct {
	Workspace string
	Trusted   bool
	// Approve blocks until the operator answers. Nil means deny.
	Approve func(ApprovalRequest) Decision
}

// Registry indexes tools by name and alias.
type Registry struct {
	tools  []Tool
	byName map[string]Tool
}

// NewRegistry builds a registry from tools.
func NewRegistry(tools ...Tool) *Registry {
	registry := &Registry{tools: tools, byName: make(map[string]Tool, len(tools)*2)}
	for _, tool := range tools {
		registry.byName[strings.ToLower(tool.Name())] = tool
		for _, alias := range tool.Aliases() {
			if alias != "" {
				registry.byName[strings.ToLower(alias)] = tool
			}
		}
	}
	return registry
}

// DefaultRegistry returns the built-in tool set.
func DefaultRegistry() *Registry {
	return NewRegistry(
		&readFileTool{},
		&listDirectoryTool{},
		&writeFileTool{},
		&editTool{},
		&multiEditTool{},
		&applyPatchTool{},
		&createDirectoryTool{},
		&deleteFileTool{},
		&moveFileTool{},
		&grepTool{},
		&globTool{},
		&codeOutlineTool{},
		&runCommandTool{},
		&envGetTool{},
		&probeURLTool{},
		&gitStatusTool{},
		&gitDiffTool{},
		&gitLogTool{},
		&gitShowTool{},
		&gitBlameTool{},
		&gitAddTool{},
		&gitCommitTool{},
		&gitBranchTool{},
		&gitRestoreTool{},
	)
}

// Lookup finds a tool by name or alias.
func (r *Registry) Lookup(name string) (Tool, bool) {
	tool, ok := r.byName[strings.ToLower(strings.TrimSpace(name))]
	return tool, ok
}

// With returns a new registry holding this registry's tools plus the extras.
//
// A name that is already taken is skipped rather than replaced. The registry
// indexes by name, so letting a contributed tool displace a built-in one would
// be a silent hijack of that call; the qualified prefix an extension uses is
// what stops the collision happening in the first place.
func (r *Registry) With(extra ...Tool) *Registry {
	combined := make([]Tool, 0, len(r.tools)+len(extra))
	combined = append(combined, r.tools...)
	taken := make(map[string]bool, len(r.tools)+len(extra))
	for _, tool := range r.tools {
		taken[strings.ToLower(tool.Name())] = true
	}
	for _, tool := range extra {
		name := strings.ToLower(tool.Name())
		if taken[name] {
			continue
		}
		taken[name] = true
		combined = append(combined, tool)
	}
	return NewRegistry(combined...)
}

// Tools returns the tools in registration order.
func (r *Registry) Tools() []Tool { return r.tools }

// Definitions lists the tool schemas offered to the model, sorted by name so
// the prompt prefix is stable across runs (which keeps prompt caching warm).
func (r *Registry) Definitions() []provider.ToolDef {
	definitions := make([]provider.ToolDef, 0, len(r.tools))
	for _, tool := range r.tools {
		definitions = append(definitions, provider.ToolDef{
			Name:        tool.Name(),
			Description: tool.Description(),
			Schema:      tool.Schema(),
		})
	}
	sort.Slice(definitions, func(i, j int) bool { return definitions[i].Name < definitions[j].Name })
	return definitions
}

// catalogEntry is the one-line tool listing used by /tools.
type catalogEntry struct {
	Name        string
	Description string
	Mutating    bool
}

// Catalog lists every tool with a short description.
func (r *Registry) Catalog() []catalogEntry {
	entries := make([]catalogEntry, 0, len(r.tools))
	for _, tool := range r.tools {
		entries = append(entries, catalogEntry{
			Name:        tool.Name(),
			Description: Shorten(tool.Description(), 70),
			Mutating:    tool.Mutating(),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries
}

// argString reads the first present alias of a string argument.
func argString(args map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := args[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				return typed
			}
		case json.Number:
			return typed.String()
		default:
			text := strings.TrimSpace(toString(typed))
			if text != "" {
				return text
			}
		}
	}
	return ""
}

// argList reads an argument that may be a list or a single string.
func argList(args map[string]any, keys ...string) []string {
	for _, key := range keys {
		value, ok := args[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case []any:
			out := make([]string, 0, len(typed))
			for _, item := range typed {
				if text := strings.TrimSpace(toString(item)); text != "" {
					out = append(out, text)
				}
			}
			return out
		case []string:
			return typed
		case string:
			parts := strings.Split(typed, ",")
			out := make([]string, 0, len(parts))
			for _, part := range parts {
				if text := strings.TrimSpace(part); text != "" {
					out = append(out, text)
				}
			}
			return out
		}
	}
	return nil
}

// argInt reads an integer argument, clamped to a range.
func argInt(args map[string]any, key string, fallback, min, max int) int {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	number := 0
	switch typed := value.(type) {
	case float64:
		number = int(typed)
	case int:
		number = typed
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return fallback
		}
		number = int(parsed)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return fallback
		}
		number = parsed
	default:
		return fallback
	}
	if number < min {
		return min
	}
	if max > 0 && number > max {
		return max
	}
	return number
}

// argBool reads a boolean argument.
func argBool(args map[string]any, key string, fallback bool) bool {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
		if err != nil {
			return fallback
		}
		return parsed
	default:
		return fallback
	}
}

func toString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return ""
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case json.Number:
		return typed.String()
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}
