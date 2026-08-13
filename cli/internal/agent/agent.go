// Package agent runs locally installed AI coding agents from the Termigo CLI.
//
// Termigo never stores provider credentials. Each provider is driven through
// its own installed CLI (or, for Ollama, its local HTTP endpoint) so that
// authentication and key handling stay where the provider put them.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// Provider describes one supported agent backend.
type Provider struct {
	ID      string
	Name    string
	Command string
	// VersionArgs returns the version line.
	VersionArgs []string
	// Local marks providers that talk to a local endpoint.
	Local bool
}

// Registry returns all supported providers in display order.
func Registry() []Provider {
	return []Provider{
		{ID: "codex", Name: "Codex CLI", Command: "codex", VersionArgs: []string{"--version"}},
		{ID: "claude", Name: "Claude Code", Command: "claude", VersionArgs: []string{"--version"}},
		{ID: "gemini", Name: "Gemini CLI", Command: "gemini", VersionArgs: []string{"--version"}},
		{ID: "antigravity", Name: "Antigravity", Command: "antigravity", VersionArgs: []string{"--version"}},
		{ID: "ollama", Name: "Ollama (local)", Command: "ollama", VersionArgs: []string{"--version"}, Local: true},
	}
}

// Status reports whether a provider is installed and its version.
type Status struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Command   string `json:"command"`
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// Detect checks each provider executable and version.
func Detect() []Status {
	statuses := make([]Status, 0, len(Registry()))
	for _, provider := range Registry() {
		status := Status{ID: provider.ID, Name: provider.Name, Command: provider.Command}
		path, err := exec.LookPath(provider.Command)
		if err != nil {
			status.Detail = fmt.Sprintf("%s was not found on PATH", provider.Command)
			statuses = append(statuses, status)
			continue
		}
		status.Available = true
		output, err := exec.Command(path, provider.VersionArgs...).CombinedOutput()
		if err == nil {
			status.Version = trim(output)
		}
		statuses = append(statuses, status)
	}
	return statuses
}

// Find returns a provider by id.
func Find(id string) (Provider, error) {
	for _, provider := range Registry() {
		if provider.ID == id {
			return provider, nil
		}
	}
	return Provider{}, fmt.Errorf("unknown provider %q (available: %s)", id, strings.Join(IDs(), ", "))
}

// IDs lists provider ids.
func IDs() []string {
	providers := Registry()
	ids := make([]string, len(providers))
	for index, provider := range providers {
		ids[index] = provider.ID
	}
	return ids
}

// RunOptions controls a single agent run.
type RunOptions struct {
	Workspace string
	Prompt    string
	// Command overrides the provider executable. It comes from the user
	// configuration and lets a provider installed outside PATH still be used.
	Command string
	// Access maps to the provider sandbox: "read-only" or "workspace-write".
	Access string
	// Model overrides the default model where the provider supports it.
	Model string
	// Endpoint overrides the local endpoint for Ollama.
	Endpoint string
	// Timeout limits the whole run; zero means no explicit limit.
	Timeout time.Duration
}

// Run executes one prompt through the selected provider, streaming output to
// out. Errors from the provider process are reported separately.
func Run(ctx context.Context, providerID string, options RunOptions, out, errOut io.Writer) error {
	provider, err := Find(providerID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(options.Prompt) == "" {
		return errors.New("prompt must not be empty")
	}
	if provider.Local {
		return runOllama(ctx, options, out)
	}
	return runCLI(ctx, provider, options, out, errOut)
}

// runCLI drives a print-mode CLI agent (codex, claude, gemini).
func runCLI(ctx context.Context, provider Provider, options RunOptions, out, errOut io.Writer) error {
	args, err := cliArgs(provider.ID, options)
	if err != nil {
		return err
	}
	executable := options.Command
	if executable == "" {
		executable = provider.Command
	}
	command := exec.CommandContext(ctx, executable, args...)
	if options.Workspace != "" {
		command.Dir = options.Workspace
	}
	command.Stdin = bytes.NewBufferString(options.Prompt + "\n")
	command.Stdout = out
	command.Stderr = errOut
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", provider.Name, err)
	}
	return nil
}

// cliArgs builds provider-specific arguments for a print-mode run. Providers
// without a known headless invocation are reported rather than launched with no
// arguments at all, which would drop the caller into an interactive session
// reading the prompt as if it were keyboard input.
func cliArgs(providerID string, options RunOptions) ([]string, error) {
	sandbox := "read-only"
	if options.Access == "workspace-write" {
		sandbox = "workspace-write"
	}
	switch providerID {
	case "codex":
		args := []string{"exec", "--json", "--color", "never", "--skip-git-repo-check", "--ephemeral", "-s", sandbox}
		if options.Workspace != "" {
			args = append(args, "-C", options.Workspace)
		}
		return append(args, "-"), nil
	case "claude":
		permission := "default"
		if options.Access == "workspace-write" {
			permission = "acceptEdits"
		}
		args := []string{"-p", "--output-format", "json", "--permission-mode", permission, "--include-partial-messages"}
		if options.Workspace != "" {
			args = append(args, "--cwd", options.Workspace)
		}
		if options.Model != "" {
			args = append(args, "--model", options.Model)
		}
		return args, nil
	case "gemini":
		args := []string{"-p"}
		if options.Workspace != "" {
			args = append(args, "--cwd", options.Workspace)
		}
		if options.Model != "" {
			args = append(args, "--model", options.Model)
		}
		return args, nil
	default:
		return nil, fmt.Errorf("provider %q has no headless run mode yet; use 'termigo agent list' to see which providers can be driven from the CLI", providerID)
	}
}

// runOllama talks to a local Ollama server over its HTTP API.
func runOllama(ctx context.Context, options RunOptions, out io.Writer) error {
	endpoint := strings.TrimRight(options.Endpoint, "/")
	if endpoint == "" {
		endpoint = "http://localhost:11434"
	}
	model := options.Model
	if model == "" {
		model = "qwen2.5-coder:latest"
	}

	payload, err := json.Marshal(map[string]any{
		"model":    model,
		"stream":   false,
		"messages": []map[string]string{{"role": "user", "content": options.Prompt}},
	})
	if err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("ollama endpoint %s unreachable: %w", endpoint, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return fmt.Errorf("ollama returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var result struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode ollama response: %w", err)
	}
	_, err = fmt.Fprintln(out, result.Message.Content)
	return err
}

// ResolveOptions merges user configuration into run options for a provider.
func ResolveOptions(base RunOptions, providerID string, config config.Config) RunOptions {
	if options, ok := config.Providers[providerID]; ok {
		if base.Command == "" {
			base.Command = options.Command
		}
		if base.Model == "" {
			base.Model = options.Model
		}
		if base.Endpoint == "" {
			base.Endpoint = options.Endpoint
		}
	}
	return base
}

func trim(value []byte) string {
	return strings.TrimSpace(string(value))
}
