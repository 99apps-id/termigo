package coder

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

// scriptedClient replays one event batch per Stream call, in order, and
// counts the calls so a test can see where the run stopped.
type scriptedClient struct {
	mu    sync.Mutex
	steps [][]provider.StreamEvent
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

// A step cut at the backend's output ceiling is a truncated step, not the
// run's end: the partial text must not be returned as the finished answer,
// and the loop continues so the next step completes it.
func TestRunContinuesAStepCutAtTheOutputCeiling(t *testing.T) {
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		{
			{Type: provider.EventTextDelta, Text: "Partial ans"},
			{Type: provider.EventIncomplete, IncompleteReason: "max_output_tokens"},
		},
		{{Type: provider.EventTextDelta, Text: "wer, finished."}},
	}}

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", MaxSteps: 6}, "answer", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "wer, finished." {
		t.Errorf("answer = %q, want the continuation step's text, not the truncated partial", out)
	}
	if calls := client.callCount(); calls != 2 {
		t.Errorf("provider calls = %d, want the truncated step and its continuation", calls)
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
