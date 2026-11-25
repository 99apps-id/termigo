package tgbridge

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"

	"github.com/99apps-id/termigo/cli/internal/coder"
	"github.com/99apps-id/termigo/cli/internal/provider"
	"github.com/99apps-id/termigo/cli/internal/secrets"
)

// Agent bridges the Telegram bot to the coder loop. The bot talks to it through
// the telegram.Agent interface. Runs are trusted: the bot has no approval
// dialog, so a mutating tool runs without asking.
type Agent struct {
	mu        sync.Mutex
	store     *secrets.Store
	workspace string
	client    provider.Client
	model     provider.Model
	session   *coder.Session
	cancel    context.CancelFunc

	// steerMu guards the messages typed while a turn is running and whether one
	// is. They are separate from mu so a steer is never stuck behind the turn.
	steerMu sync.Mutex
	steers  []string
	turning bool
}

// NewAgent builds a bridge for a provider and model.
func NewAgent(store *secrets.Store, workspace string, model provider.Model) (*Agent, error) {
	agent := &Agent{
		store:     store,
		workspace: workspace,
		model:     model,
		session:   coder.NewSession(workspace, model.WireID()),
	}
	if err := agent.applyModel(model); err != nil {
		return nil, err
	}
	return agent, nil
}

// Workspace reports the directory every run is rooted in, so the Telegram bot
// can save uploads into `.termigo/uploads` instead of only reporting a size.
func (a *Agent) Workspace() string { return a.workspace }

// GitDiff returns the workspace's uncommitted changes for /diff.
//
// The bot advertises /diff in its command menu and help text, and it looks for
// this method: without it every call answered "Diff is not supported by this
// agent" even though the workspace is right here.
func (a *Agent) GitDiff(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "git", "-C", a.workspace, "diff")
	var stderr strings.Builder
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		// git's own words ("not a git repository", "unknown revision") are the
		// actionable part; a bare exit status is not.
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return "", errors.New(message)
		}
		return "", err
	}
	return string(output), nil
}

func (a *Agent) applyModel(model provider.Model) error {
	client, err := provider.NewClient(model.Provider, provider.DefaultBaseURL(model.Provider), provider.ResolverFor(a.store))
	if err != nil {
		return err
	}
	provider.SetForceResolver(client, a.store)
	a.client = client
	a.model = model
	if a.session != nil {
		a.session.Model = model.WireID()
	}
	return nil
}

// RunPrompt runs one turn.
func (a *Agent) RunPrompt(ctx context.Context, prompt string, progress func(string)) (string, error) {
	return a.run(ctx, prompt, nil, progress, nil)
}

// RunPromptStream runs one turn and also reports the answer as it is written,
// so the bot can show it in the card instead of waiting for the end.
func (a *Agent) RunPromptStream(ctx context.Context, prompt string, progress func(string), text func(string)) (string, error) {
	return a.run(ctx, prompt, nil, progress, text)
}

// RunPromptWithImage runs one turn with an image attached.
func (a *Agent) RunPromptWithImage(ctx context.Context, prompt, mediaType, data string, progress func(string)) (string, error) {
	return a.run(ctx, prompt, []provider.Image{{MediaType: mediaType, Data: data}}, progress, nil)
}

// Steer queues a message for the turn that is running, and reports false when
// none is, so the bot can treat the message as a new prompt instead.
func (a *Agent) Steer(prompt string) bool {
	text := strings.TrimSpace(prompt)
	if text == "" {
		return false
	}
	a.steerMu.Lock()
	defer a.steerMu.Unlock()
	if !a.turning {
		return false
	}
	a.steers = append(a.steers, text)
	return true
}

func (a *Agent) takeSteers() []string {
	a.steerMu.Lock()
	defer a.steerMu.Unlock()
	taken := a.steers
	a.steers = nil
	return taken
}

// settle ends the turn, unless a steer arrived after the last step took its
// share: those come back so they run as a follow-up turn instead of being lost
// between the model's final answer and the end of the turn.
func (a *Agent) settle(abandon bool) []string {
	a.steerMu.Lock()
	defer a.steerMu.Unlock()
	pending := a.steers
	a.steers = nil
	if abandon || len(pending) == 0 {
		a.turning = false
		return nil
	}
	return pending
}

func (a *Agent) run(ctx context.Context, prompt string, images []provider.Image, progress func(string), text func(string)) (string, error) {
	a.steerMu.Lock()
	a.turning = true
	a.steerMu.Unlock()

	var answers []string
	for {
		answer, err := a.runOnce(ctx, prompt, images, progress, text)
		if err != nil {
			a.settle(true)
			return strings.Join(answers, "\n\n"), err
		}
		if strings.TrimSpace(answer) != "" {
			answers = append(answers, answer)
		}
		pending := a.settle(ctx.Err() != nil)
		if len(pending) == 0 {
			return strings.Join(answers, "\n\n"), nil
		}
		prompt, images = strings.Join(pending, "\n\n"), nil
	}
}

func (a *Agent) runOnce(ctx context.Context, prompt string, images []provider.Image, progress func(string), text func(string)) (string, error) {
	a.mu.Lock()
	client := a.client
	model := a.model
	if a.session == nil {
		a.session = coder.NewSession(a.workspace, model.WireID())
	}
	session := a.session
	a.mu.Unlock()
	if client == nil {
		return "", errors.New("no model is configured")
	}

	runCtx, cancel := context.WithCancel(ctx)
	a.mu.Lock()
	a.cancel = cancel
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.cancel = nil
		a.mu.Unlock()
		cancel()
	}()

	// step is the text since the last tool call. Words written before a call
	// are narration, so a call empties it; only the text that follows the last
	// call, or a step that makes none, is the answer being written.
	var step strings.Builder
	onEvent := func(event provider.StreamEvent) {
		switch event.Type {
		case provider.EventTextDelta:
			step.WriteString(event.Text)
			if text != nil {
				text(step.String())
			}
		case provider.EventToolCall:
			if event.ToolCall == nil {
				return
			}
			if step.Len() > 0 {
				step.Reset()
				if text != nil {
					text("")
				}
			}
			if progress != nil {
				progress(coder.ToolLabel(*event.ToolCall))
			}
		}
	}
	return coder.Run(runCtx, coder.Options{
		Client:  client,
		Model:   model.WireID(),
		Images:  images,
		Session: session,
		Steer:   a.takeSteers,
		Env: &coder.Env{
			Workspace: a.workspace,
			Trusted:   true,
			Secrets:   a.store,
			Approve:   func(coder.ApprovalRequest) coder.Decision { return coder.DecisionAllowOnce },
		},
	}, prompt, onEvent)
}

// Stop cancels the running turn.
func (a *Agent) Stop() {
	a.mu.Lock()
	cancel := a.cancel
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// NewSession resets the conversation history for a fresh Telegram session.
func (a *Agent) NewSession() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.session = coder.NewSession(a.workspace, a.model.WireID())
}

// Model returns the current model id.
func (a *Agent) Model() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.model.ID
}

// SetModel switches the model by id or search text.
func (a *Agent) SetModel(query string) (string, error) {
	model, ok := provider.ModelFromQuery(query)
	if !ok {
		return "", fmt.Errorf("unknown model %q", query)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.applyModel(model); err != nil {
		return "", err
	}
	return model.ID, nil
}

// Status returns a short status block.
func (a *Agent) Status() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return fmt.Sprintf("model: %s\nworkspace: %s", a.model.ID, a.workspace)
}
