package tgbridge

import (
	"context"
	"errors"
	"fmt"
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
	cancel    context.CancelFunc
}

// NewAgent builds a bridge for a provider and model.
func NewAgent(store *secrets.Store, workspace string, model provider.Model) (*Agent, error) {
	agent := &Agent{store: store, workspace: workspace, model: model}
	if err := agent.applyModel(model); err != nil {
		return nil, err
	}
	return agent, nil
}

func (a *Agent) applyModel(model provider.Model) error {
	client, err := provider.NewClient(model.Provider, provider.DefaultBaseURL(model.Provider), provider.ResolverFor(a.store))
	if err != nil {
		return err
	}
	provider.SetForceResolver(client, a.store)
	a.client = client
	a.model = model
	return nil
}

// RunPrompt runs one turn.
func (a *Agent) RunPrompt(ctx context.Context, prompt string, progress func(string)) (string, error) {
	return a.run(ctx, prompt, nil, progress)
}

// RunPromptWithImage runs one turn with an image attached.
func (a *Agent) RunPromptWithImage(ctx context.Context, prompt, mediaType, data string, progress func(string)) (string, error) {
	return a.run(ctx, prompt, []provider.Image{{MediaType: mediaType, Data: data}}, progress)
}

func (a *Agent) run(ctx context.Context, prompt string, images []provider.Image, progress func(string)) (string, error) {
	a.mu.Lock()
	client := a.client
	model := a.model
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

	onEvent := func(event provider.StreamEvent) {
		if progress == nil {
			return
		}
		if event.Type == provider.EventToolCall && event.ToolCall != nil {
			progress("tool: " + event.ToolCall.Name)
		}
	}
	return coder.Run(runCtx, coder.Options{
		Client: client,
		Model:  model.WireID(),
		Images: images,
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

// NewSession is a no-op: each Telegram turn starts a fresh run.
func (a *Agent) NewSession() {}

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
