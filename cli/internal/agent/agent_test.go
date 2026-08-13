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
	args, err := cliArgs("codex", RunOptions{Workspace: "C:/work", Access: "read-only"})
	if err != nil {
		t.Fatalf("cliArgs(codex) failed: %v", err)
	}
	want := []string{"exec", "--json", "--color", "never", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "C:/work", "-"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("codex args = %v, want %v", args, want)
	}
}

func TestCLIArgsForClaudeWithWriteAccess(t *testing.T) {
	args, err := cliArgs("claude", RunOptions{Workspace: "C:/work", Access: "workspace-write"})
	if err != nil {
		t.Fatalf("cliArgs(claude) failed: %v", err)
	}
	if !contains(args, "--permission-mode") || !contains(args, "acceptEdits") {
		t.Fatalf("claude args missing permission mode: %v", args)
	}
	if !contains(args, "--cwd") || !contains(args, "C:/work") {
		t.Fatalf("claude args missing cwd: %v", args)
	}
}

// A provider with no headless invocation must fail loudly instead of being
// launched bare, which would silently start an interactive session.
func TestCLIArgsRejectsProviderWithoutHeadlessMode(t *testing.T) {
	if _, err := cliArgs("antigravity", RunOptions{Prompt: "hello"}); err == nil {
		t.Fatal("expected an error for a provider without a headless run mode")
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

// A provider CLI installed outside PATH is configured with "command"; that
// override has to reach the process that is actually executed.
func TestResolveOptionsAppliesCommandOverride(t *testing.T) {
	cfg := config.Config{
		Providers: map[string]config.ProviderOptions{
			"codex": {Command: `C:/tools/codex.exe`},
		},
	}
	resolved := ResolveOptions(RunOptions{}, "codex", cfg)
	if resolved.Command != `C:/tools/codex.exe` {
		t.Fatalf("command override was dropped: %q", resolved.Command)
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
