package coder

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

// A message typed while a run is working reaches the model on its next step,
// after the tool results and before it answers, instead of waiting for the run
// to end.
func TestRunTakesASteerBeforeTheNextStep(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		{{Type: provider.EventToolCall, ToolCall: &provider.ToolCall{ID: "c1", Name: "read_file", Arguments: `{"path":"note.txt"}`}}},
		{{Type: provider.EventTextDelta, Text: "Done, tests included."}},
	}}
	asked := 0
	steer := func() []string {
		asked++
		if asked == 1 {
			return []string{"also add tests", "   "}
		}
		return nil
	}

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", Env: &Env{Workspace: workspace}, Steer: steer}, "read the note", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "Done, tests included." {
		t.Fatalf("answer = %q", out)
	}
	messages := client.request(1).Messages
	last := messages[len(messages)-1]
	if last.Role != provider.RoleUser || last.Content != "also add tests" {
		t.Fatalf("the steer should end the second request, got %+v", last)
	}
	if messages[len(messages)-2].Role != provider.RoleTool {
		t.Fatalf("the steer must follow the tool result, not split it: %+v", messages[len(messages)-2])
	}
	for _, message := range messages {
		if message.Role == provider.RoleUser && message.Content == "" {
			t.Fatalf("a blank steer must not become a message")
		}
	}
}

// The first step takes the prompt as written: a steer is for a run already
// under way, and asking for one before the first request would only reorder it.
func TestRunDoesNotAskForASteerBeforeTheFirstStep(t *testing.T) {
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		{{Type: provider.EventTextDelta, Text: "ok"}},
	}}
	asked := 0
	_, err := Run(context.Background(), Options{Client: client, Model: "fake", Steer: func() []string { asked++; return nil }}, "hi", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if asked != 0 {
		t.Fatalf("a one-step run never consults the steer, asked %d times", asked)
	}
}

// A steer is new information, so it clears the repetition guard: a run that was
// about to be stopped for repeating itself may continue.
func TestSteerClearsTheRepetitionGuard(t *testing.T) {
	workspace := t.TempDir()
	call := provider.StreamEvent{Type: provider.EventToolCall, ToolCall: &provider.ToolCall{ID: "c", Name: "list_directory", Arguments: `{"path":"."}`}}
	client := &scriptedClient{steps: [][]provider.StreamEvent{
		{call}, {call}, {call}, {call},
		{{Type: provider.EventTextDelta, Text: "finished"}},
	}}
	step := 0
	steer := func() []string {
		step++
		if step == 2 {
			return []string{"keep going"}
		}
		return nil
	}
	out, err := Run(context.Background(), Options{Client: client, Model: "fake", Env: &Env{Workspace: workspace}, Steer: steer, MaxSteps: 8}, "list", nil)
	if err != nil {
		t.Fatalf("a steer should have reset the guard, got %v", err)
	}
	if out != "finished" {
		t.Fatalf("answer = %q", out)
	}
}
