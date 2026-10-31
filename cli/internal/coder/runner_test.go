package coder

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

// scriptedClient replays one event batch per Stream call, in order, and
// counts the calls so a test can see where the run stopped. errs, when long
// enough, is the error each step's stream ends with after its events.
type scriptedClient struct {
	mu    sync.Mutex
	steps [][]provider.StreamEvent
	errs  []error
	calls int
}

func (f *scriptedClient) ID() string { return "scripted" }

func (f *scriptedClient) Stream(_ context.Context, _ provider.ChatRequest, emit func(provider.StreamEvent) error) error {
	f.mu.Lock()
	index := f.calls
	f.calls++
	f.mu.Unlock()
	if index >= len(f.steps) {
		return nil
	}
	for _, event := range f.steps[index] {
		if err := emit(event); err != nil {
			return err
		}
	}
	if index < len(f.errs) {
		return f.errs[index]
	}
	return nil
}

func (f *scriptedClient) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// A reasoning-only step is model output, not an idle one: a reasoning model
// that thinks for several steps before answering must not trip the empty-step
// guard, or a working run is reported as stuck.
func TestRunReasoningOnlyStepsAreNotIdle(t *testing.T) {
	reasoningOnly := []provider.StreamEvent{
		{Type: provider.EventReasoningDelta, Text: "Working through the problem."},
	}
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		reasoningOnly, reasoningOnly, reasoningOnly, reasoningOnly,
		{{Type: provider.EventTextDelta, Text: "Finished."}},
	}}

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", MaxSteps: 6}, "think hard", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "Finished." {
		t.Errorf("answer = %q, want the final text step", out)
	}
	if calls := client.callCount(); calls != 5 {
		t.Errorf("provider calls = %d, want all 5 steps consumed", calls)
	}
}

// A step whose thinking never streamed (the backend billed reasoning tokens
// but sent no summary) is still the model working: the usage alone must
// reset the empty streak, or reasoning models whose summaries do not stream
// are filed as idle while demonstrably thinking.
func TestRunReasoningTokenOnlyStepsAreNotIdle(t *testing.T) {
	thinking := []provider.StreamEvent{
		{Type: provider.EventUsage, Usage: &provider.Usage{PromptTokens: 100, CompletionTokens: 60, TotalTokens: 160, ReasoningTokens: 55}},
	}
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		thinking, thinking, thinking, thinking,
		{{Type: provider.EventTextDelta, Text: "Finished."}},
	}}

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", MaxSteps: 6}, "think hard", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "Finished." {
		t.Errorf("answer = %q, want the final text step", out)
	}
	if calls := client.callCount(); calls != 5 {
		t.Errorf("provider calls = %d, want all 5 steps consumed", calls)
	}
}

// The step's reasoning items ride on its stored message: they are the only
// copy of the thought a stateless backend produced, and the next request
// replays them from there.
func TestRunStoresReasoningItemsOnTheStep(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	item := provider.ReasoningItem{ID: "rs_1", EncryptedContent: "enc_abc", Summary: []string{"thought one"}}
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		{
			{Type: provider.EventReasoningItem, ReasoningItem: &item},
			{Type: provider.EventToolCall, ToolCall: &provider.ToolCall{ID: "call_1", Name: "read_file", Arguments: `{"path":"note.txt"}`}},
		},
		{{Type: provider.EventTextDelta, Text: "The note says hi."}},
	}}
	session := NewSession(workspace, "fake")

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", Env: &Env{Workspace: workspace}, Session: session}, "read the note", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "The note says hi." {
		t.Fatalf("answer = %q, want the final text step", out)
	}
	for _, message := range session.Messages {
		if message.Role != provider.RoleAssistant || len(message.ToolCalls) == 0 {
			continue
		}
		if len(message.ReasoningItems) != 1 || message.ReasoningItems[0].EncryptedContent != "enc_abc" || message.ReasoningItems[0].ID != "rs_1" {
			t.Errorf("the tool step's reasoning items = %+v, want the streamed item stored", message.ReasoningItems)
		}
		return
	}
	t.Errorf("no stored assistant message carries the tool step: %+v", session.Messages)
}

// A step with no output at all is still idle: three of them in a row stop the
// run with the guard's error, and no further step is attempted.
func TestRunTrulyEmptyStepsStopAsIdle(t *testing.T) {
	empty := []provider.StreamEvent{}
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		empty, empty, empty,
		{{Type: provider.EventTextDelta, Text: "never reached"}},
	}}

	_, err := Run(context.Background(), Options{Client: client, Model: "fake", MaxSteps: 6}, "say something", nil)
	if err == nil || !strings.Contains(err.Error(), "no text and no tool calls") {
		t.Fatalf("err = %v, want the idle guard's stop", err)
	}
	if calls := client.callCount(); calls != 3 {
		t.Errorf("provider calls = %d, want the guard to stop at 3 empty steps", calls)
	}
}

// A step the backend cut at its output ceiling is not a failed run: the
// partial answer stays in the transcript, the model is asked to finish, and
// the next step's answer is returned.
func TestRunTruncatedStepKeepsPartialAnswerAndContinues(t *testing.T) {
	workspace := t.TempDir()
	client := &scriptedClient{
		steps: [][]provider.StreamEvent{
			{{Type: provider.EventTextDelta, Text: "Partial answer."}},
			{{Type: provider.EventTextDelta, Text: "The rest of it."}},
		},
		errs: []error{
			fmt.Errorf("ChatGPT stream interrupted: %w: the Responses backend ended the response incomplete (max_output_tokens) before the step finished", provider.ErrOutputTruncated),
			nil,
		},
	}
	session := NewSession(workspace, "fake")

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", Env: &Env{Workspace: workspace}, Session: session}, "answer briefly", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "The rest of it." {
		t.Fatalf("answer = %q, want the continuation step's answer", out)
	}
	var sawPartial, sawNudge bool
	for _, message := range session.Messages {
		if message.Role == provider.RoleAssistant && message.Content == "Partial answer." {
			sawPartial = true
		}
		if message.Role == provider.RoleUser && strings.Contains(message.Content, "cut off") {
			sawNudge = true
		}
	}
	if !sawPartial || !sawNudge {
		t.Errorf("session = %+v, want the partial answer kept and a continue nudge recorded", session.Messages)
	}
}

// A truncated step with no visible output still counts the model's thinking
// as progress, and the plain nudge recovers the answer on the next step.
func TestRunTruncatedEmptyStepNudgesInsteadOfFailing(t *testing.T) {
	client := &scriptedClient{
		steps: [][]provider.StreamEvent{
			{{Type: provider.EventReasoningDelta, Text: "thinking"}},
			{{Type: provider.EventTextDelta, Text: "Finished."}},
		},
		errs: []error{
			fmt.Errorf("stream interrupted: %w", provider.ErrOutputTruncated),
			nil,
		},
	}

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", MaxSteps: 4}, "answer", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "Finished." {
		t.Fatalf("answer = %q, want the nudged step's answer", out)
	}
}

// Only the output ceiling is recoverable: any other stream error still fails
// the run instead of being swallowed as a nudge.
func TestRunNonTruncationStreamErrorStillFails(t *testing.T) {
	client := &scriptedClient{
		steps: [][]provider.StreamEvent{{}},
		errs:  []error{errors.New("boom")},
	}

	_, err := Run(context.Background(), Options{Client: client, Model: "fake", MaxSteps: 2}, "answer", nil)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want the provider's stream error", err)
	}
}
