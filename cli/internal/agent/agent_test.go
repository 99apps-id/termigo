package agent

import (
	"reflect"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/config"
)

func TestDetectWithoutProvidersIsGraceful(t *testing.T) {
	// Test environments rarely have codex/claude/gemini installed; the
	// report must still be well-formed and never fail.
	statuses := Detect()
	if len(statuses) == 0 {
		t.Fatal("Detect returned no providers")
	}
	for _, status := range statuses {
		if status.ID == "" || status.Name == "" {
			t.Fatalf("provider missing id/name: %+v", status)
		}
	}
}

func TestFindUnknownProvider(t *testing.T) {
	if _, err := Find("not-a-provider"); err == nil {
		t.Fatal("Find accepted an unknown provider")
	}
	if _, err := Find("codex"); err != nil {
		t.Fatalf("Find(codex) failed: %v", err)
	}
}

func TestCLIArgsForCodex(t *testing.T) {
	args := cliArgs("codex", RunOptions{Workspace: "C:/work", Access: "read-only"})
	want := []string{"exec", "--json", "--color", "never", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "C:/work", "-"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("codex args = %v, want %v", args, want)
	}
}

func TestCLIArgsForClaudeWithWriteAccess(t *testing.T) {
	args := cliArgs("claude", RunOptions{Workspace: "C:/work", Access: "workspace-write"})
	joined := ""
	for _, arg := range args {
		joined += arg + " "
	}
	if !contains(args, "--permission-mode") || !contains(args, "acceptEdits") {
		t.Fatalf("claude args missing permission mode: %v", args)
	}
	if !contains(args, "--cwd") || !contains(args, "C:/work") {
		t.Fatalf("claude args missing cwd: %v", args)
	}
}

func TestResolveOptionsMergesConfig(t *testing.T) {
	options := RunOptions{}
	cfg := config.Config{
		Providers: map[string]config.ProviderOptions{
			"ollama": {Model: "qwen3", Endpoint: "http://localhost:11434"},
		},
	}
	resolved := ResolveOptions(options, "ollama", cfg)
	if resolved.Model != "qwen3" || resolved.Endpoint != "http://localhost:11434" {
		t.Fatalf("resolved = %+v", resolved)
	}

	// Explicit options win over the config.
	options = RunOptions{Model: "explicit"}
	resolved = ResolveOptions(options, "ollama", cfg)
	if resolved.Model != "explicit" {
		t.Fatalf("explicit model was overridden: %q", resolved.Model)
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
