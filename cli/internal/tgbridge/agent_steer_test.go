package tgbridge

import (
	"context"
	"sync"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/coder"
	"github.com/99apps-id/termigo/cli/internal/provider"
)

// stepClient replays one batch of events per request and runs a hook inside
// the request, which is where a message typed mid-turn arrives.
type stepClient struct {
	mu       sync.Mutex
	steps    [][]provider.StreamEvent
	calls    int
	requests []provider.ChatRequest
	during   func(call int)
}

func (c *stepClient) ID() string { return "step" }

func (c *stepClient) Stream(_ context.Context, request provider.ChatRequest, emit func(provider.StreamEvent) error) error {
	c.mu.Lock()
	index := c.calls
	c.calls++
	request.Messages = append([]provider.Message(nil), request.Messages...)
	c.requests = append(c.requests, request)
	c.mu.Unlock()
	if c.during != nil {
		c.during(index)
	}
	if index >= len(c.steps) {
		return nil
	}
	for _, event := range c.steps[index] {
		if err := emit(event); err != nil {
			return err
		}
	}
	return nil
}

func newTestAgent(t *testing.T, client provider.Client) *Agent {
	t.Helper()
	dir := t.TempDir()
	model := provider.Model{ID: "m"}
	return &Agent{workspace: dir, client: client, model: model, session: coder.NewSession(dir, "m")}
}

func text(value string) []provider.StreamEvent {
	return []provider.StreamEvent{{Type: provider.EventTextDelta, Text: value}}
}

func listCall() []provider.StreamEvent {
	return []provider.StreamEvent{{Type: provider.EventToolCall, ToolCall: &provider.ToolCall{ID: "c1", Name: "list_directory", Arguments: `{"path":"."}`}}}
}

func TestSteerIsRefusedWhenNoTurnIsRunning(t *testing.T) {
	agent := newTestAgent(t, &stepClient{})
	if agent.Steer("anything") {
		t.Fatal("there is no turn to steer")
	}
}

// A message that arrives while the turn is working reaches the model on its next
// step, inside the same turn.
func TestSteerReachesTheRunningTurn(t *testing.T) {
	client := &stepClient{steps: [][]provider.StreamEvent{listCall(), text("done with tests")}}
	agent := newTestAgent(t, client)
	client.during = func(call int) {
		if call == 0 && !agent.Steer("also add tests") {
			t.Error("a running turn should take the steer")
		}
	}
	answer, err := agent.RunPrompt(context.Background(), "list the folder", nil)
	if err != nil {
		t.Fatalf("RunPrompt: %v", err)
	}
	if answer != "done with tests" {
		t.Fatalf("answer = %q", answer)
	}
	if client.calls != 2 {
		t.Fatalf("one turn, two steps; got %d requests", client.calls)
	}
	last := client.requests[1].Messages[len(client.requests[1].Messages)-1]
	if last.Role != provider.RoleUser || last.Content != "also add tests" {
		t.Fatalf("the steer should end the second request, got %+v", last)
	}
	if agent.Steer("late") {
		t.Fatal("the turn is over, so a steer is refused again")
	}
}

// A steer that lands after the last step took its share still gets answered: it
// runs as a follow-up turn and both answers come back, instead of the message
// being accepted and then dropped.
func TestSteerAfterTheLastStepRunsAsAFollowUp(t *testing.T) {
	client := &stepClient{steps: [][]provider.StreamEvent{text("first answer"), text("second answer")}}
	agent := newTestAgent(t, client)
	client.during = func(call int) {
		if call == 0 && !agent.Steer("one more thing") {
			t.Error("a running turn should take the steer")
		}
	}
	answer, err := agent.RunPrompt(context.Background(), "do it", nil)
	if err != nil {
		t.Fatalf("RunPrompt: %v", err)
	}
	if answer != "first answer\n\nsecond answer" {
		t.Fatalf("answer = %q", answer)
	}
	if client.calls != 2 {
		t.Fatalf("want a follow-up request, got %d", client.calls)
	}
	prompt := client.requests[1].Messages[len(client.requests[1].Messages)-1]
	if prompt.Role != provider.RoleUser || prompt.Content != "one more thing" {
		t.Fatalf("the follow-up should carry the steer, got %+v", prompt)
	}
}
