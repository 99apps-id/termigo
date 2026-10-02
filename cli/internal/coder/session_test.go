package coder

import (
	"context"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/provider"
)

func TestSessionRoundTripAndLatest(t *testing.T) {
	t.Setenv(config.EnvHome, t.TempDir())
	workspace := "/work/a"

	first := NewSession(workspace, "muse-spark-1.3")
	first.Messages = []provider.Message{{Role: provider.RoleUser, Content: "hello"}}
	if err := first.Save(); err != nil {
		t.Fatalf("save first: %v", err)
	}
	second := NewSession(workspace, "muse-spark-1.3")
	second.Messages = []provider.Message{{Role: provider.RoleUser, Content: "second"}}
	if err := second.Save(); err != nil {
		t.Fatalf("save second: %v", err)
	}
	if first.ID == second.ID {
		t.Fatalf("session ids collided: %s", first.ID)
	}

	loaded, err := LoadSession(first.ID)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Messages) != 1 || loaded.Messages[0].Content != "hello" {
		t.Errorf("loaded messages = %+v", loaded.Messages)
	}

	latest, err := LatestSession(workspace)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if latest == nil || latest.ID != second.ID {
		t.Fatalf("latest = %+v, want %s", latest, second.ID)
	}

	if other, err := LatestSession("/work/b"); err != nil || other != nil {
		t.Errorf("a different workspace should have no session, got %+v err=%v", other, err)
	}
}

// fakeClient streams a fixed reply and records how many messages each request
// carried, which is how the continuity test sees the history grow.
type fakeClient struct {
	reply string
	seen  []int
}

func (f *fakeClient) ID() string { return "fake" }

func (f *fakeClient) Stream(_ context.Context, req provider.ChatRequest, emit func(provider.StreamEvent) error) error {
	f.seen = append(f.seen, len(req.Messages))
	if err := emit(provider.StreamEvent{Type: provider.EventTextDelta, Text: f.reply}); err != nil {
		return err
	}
	return emit(provider.StreamEvent{Type: provider.EventUsage, Usage: &provider.Usage{PromptTokens: 3, CompletionTokens: 2, TotalTokens: 5}})
}

func TestRunRecordsAndContinuesASession(t *testing.T) {
	t.Setenv(config.EnvHome, t.TempDir())
	session := NewSession("/work", "fake")
	client := &fakeClient{reply: "hi there"}

	out, err := Run(context.Background(), Options{Client: client, Model: "fake", Session: session}, "hello world", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out != "hi there" {
		t.Errorf("out = %q, want the reply", out)
	}
	if len(session.Messages) != 2 {
		t.Fatalf("session messages = %d, want user and assistant", len(session.Messages))
	}
	if session.Messages[0].Role != provider.RoleUser || session.Messages[0].Content != "hello world" {
		t.Errorf("first message = %+v", session.Messages[0])
	}
	if session.Messages[1].Role != provider.RoleAssistant || session.Messages[1].Content != "hi there" {
		t.Errorf("second message = %+v", session.Messages[1])
	}
	if session.Title != "hello world" {
		t.Errorf("title = %q", session.Title)
	}

	// A second turn must carry the two stored messages plus the new prompt.
	if _, err := Run(context.Background(), Options{Client: client, Model: "fake", Session: session}, "again", nil); err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if len(client.seen) != 2 || client.seen[0] != 1 || client.seen[1] != 3 {
		t.Errorf("messages seen per request = %v, want [1 3]", client.seen)
	}
	if session.Usage.TotalTokens != 10 {
		t.Errorf("session usage total = %d, want 10 (two turns of 5)", session.Usage.TotalTokens)
	}
}
