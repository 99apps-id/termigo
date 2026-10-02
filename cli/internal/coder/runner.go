package coder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

// defaultMaxSteps bounds one run so a looping model cannot spin forever.
const defaultMaxSteps = 40

// systemPrompt is the coding-agent instruction the runner sends.
const systemPrompt = "You are a terminal coding agent working in the user's project. " +
	"Read files before editing them, make the smallest correct change, and verify with a check when one exists. " +
	"Use the tools instead of guessing. When the task is done, reply with a short summary."

// Options configures one agent run.
type Options struct {
	Client   provider.Client
	Model    string
	Env      *Env
	MaxSteps int
	System   string
	// Images attach to the first user message, for a vision model.
	Images []provider.Image
	// Session, when set, seeds the run with its prior messages and collects the
	// messages this run produces, so a caller can persist them and a later run
	// continues the conversation.
	Session *Session
	// Tools are extra tools offered alongside the built-ins, such as the ones
	// an MCP server exposes.
	Tools []Tool
}

// Run drives one coding turn: stream a completion, execute any tool calls, feed
// the results back, and repeat until the model answers without a tool call or
// the step budget runs out.
func Run(ctx context.Context, opts Options, prompt string, emit func(provider.StreamEvent)) (string, error) {
	if opts.Client == nil {
		return "", errors.New("no provider client")
	}
	env := opts.Env
	if env == nil {
		env = &Env{}
	}
	registry := DefaultRegistry()
	if len(opts.Tools) > 0 {
		registry = registry.With(opts.Tools...)
	}
	maxSteps := opts.MaxSteps
	if maxSteps <= 0 {
		maxSteps = defaultMaxSteps
	}
	system := opts.System
	if strings.TrimSpace(system) == "" {
		system = systemPrompt
	}
	definitions := registry.Definitions()

	guard := &loopGuard{}
	var messages []provider.Message
	if opts.Session != nil {
		messages = append(messages, opts.Session.Messages...)
	}
	messages = append(messages, provider.Message{Role: provider.RoleUser, Content: prompt, Images: opts.Images})
	last := ""

	// Collect the conversation into the session before returning, from any
	// path. Images are dropped: a base64 payload would bloat the session file
	// and cannot be replayed to a later model turn anyway.
	if opts.Session != nil {
		session := opts.Session
		defer func() {
			for index := range messages {
				messages[index].Images = nil
			}
			session.Messages = messages
			if session.Title == "" {
				session.Title = sessionTitle(prompt)
			}
		}()
	}

	for step := 0; step < maxSteps; step++ {
		var text strings.Builder
		var calls []provider.ToolCall
		err := opts.Client.Stream(ctx, provider.ChatRequest{
			Model:    opts.Model,
			System:   system,
			Messages: messages,
			Tools:    definitions,
		}, func(event provider.StreamEvent) error {
			switch event.Type {
			case provider.EventTextDelta:
				text.WriteString(event.Text)
			case provider.EventToolCall:
				if event.ToolCall != nil {
					calls = append(calls, *event.ToolCall)
				}
			case provider.EventUsage:
				if event.Usage != nil && opts.Session != nil {
					opts.Session.Usage = opts.Session.Usage.Add(*event.Usage)
				}
			}
			if emit != nil {
				emit(event)
			}
			return nil
		})
		if err != nil {
			return "", err
		}

		if len(calls) == 0 {
			last = strings.TrimSpace(text.String())
			if last == "" {
				if stop, reason := guard.noteEmptyStep(); stop {
					return "", errors.New(reason)
				}
				messages = append(messages, provider.Message{Role: provider.RoleUser, Content: "Reply with the answer."})
				continue
			}
			messages = append(messages, provider.Message{Role: provider.RoleAssistant, Content: last})
			return last, nil
		}
		guard.noteProgress()
		messages = append(messages, provider.Message{Role: provider.RoleAssistant, Content: text.String(), ToolCalls: calls})

		for _, call := range calls {
			if stop, reason := guard.noteCall(call.Name, call.Arguments); stop {
				return "", errors.New(reason)
			}
			result := executeTool(ctx, env, registry, call)
			messages = append(messages, provider.Message{
				Role:    provider.RoleTool,
				ToolID:  call.ID,
				Name:    call.Name,
				Content: result.Output,
			})
			if stop, reason := guard.noteResult(result.IsError); stop {
				return "", errors.New(reason)
			}
		}
	}
	return last, fmt.Errorf("reached the %d step budget without a final answer", maxSteps)
}

// executeTool resolves a call, enforces approval for a mutating tool, and runs
// it. A tool error is returned as the tool output so the model can react.
func executeTool(ctx context.Context, env *Env, registry *Registry, call provider.ToolCall) Result {
	tool, ok := registry.Lookup(call.Name)
	if !ok {
		return Result{Output: fmt.Sprintf("unknown tool %q", call.Name), IsError: true}
	}
	args := decodeArgs(call.Arguments)
	if tool.Mutating() {
		if env.Approve == nil {
			return Result{Output: fmt.Sprintf("%s changes files or runs a command and needs approval; re-run with --yes to allow it", tool.Name()), IsError: true}
		}
		decision := env.Approve(ApprovalRequest{Tool: tool.Name(), Risk: string(tool.Risk()), Detail: tool.Label(args)})
		if decision == DecisionDeny {
			return Result{Output: "the operator denied this call", IsError: true}
		}
	}
	result, err := tool.Run(ctx, env, args)
	if err != nil {
		return Result{Output: err.Error(), IsError: true}
	}
	return result
}

// sessionTitle is the first line of the first prompt, clipped, so the session
// list is readable.
func sessionTitle(prompt string) string {
	line := strings.TrimSpace(strings.SplitN(prompt, "\n", 2)[0])
	if len(line) > 60 {
		line = line[:60]
	}
	return line
}

// decodeArgs parses a tool call's JSON arguments, tolerating an empty payload.
func decodeArgs(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil || decoded == nil {
		return map[string]any{}
	}
	return decoded
}
