// Package tui is the interactive Bubble Tea front end for the Termigo agent:
// a scrolling transcript, a prompt, streamed thinking and tool calls, and an
// inline approval prompt.
package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/99apps-id/termigo/cli/internal/coder"
	"github.com/99apps-id/termigo/cli/internal/provider"
	"github.com/99apps-id/termigo/cli/internal/secrets"
)

type blockKind int

const (
	blockUser blockKind = iota
	blockAssistant
	blockReasoning
	blockTool
	blockError
	blockNotice
)

type block struct {
	kind blockKind
	text string
}

type eventMsg struct {
	kind blockKind
	text string
	done bool
}

type errMsg struct{ err error }

type approvalMsg struct {
	tool   string
	detail string
	reply  chan bool
}

// Model is the Bubble Tea model.
type Model struct {
	client    provider.Client
	model     provider.Model
	store     *secrets.Store
	workspace string

	input   textarea.Model
	blocks  []block
	width   int
	height  int
	running bool
	cancel  context.CancelFunc
	events  chan eventMsg
	program *tea.Program

	pendingTool   string
	pendingDetail string
	pendingReply  chan bool

	// picker selects a model from a list, opened by a bare /model.
	pickerActive bool
	pickerItems  []provider.Model
	pickerCursor int
}

var (
	userStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("12")).Bold(true)
	assistantStyle = lipgloss.NewStyle()
	reasoningStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("8")).Italic(true)
	toolStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	errorStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	noticeStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	statusStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
)

// Run starts the TUI and blocks until the operator quits.
func Run(store *secrets.Store, workspace string, model provider.Model) error {
	client, err := provider.NewClient(model.Provider, provider.DefaultBaseURL(model.Provider), provider.ResolverFor(store))
	if err != nil {
		return err
	}
	provider.SetForceResolver(client, store)

	input := textarea.New()
	input.Placeholder = "Ask, or type /help. Enter to send, Ctrl+J for a newline."
	input.Focus()

	m := &Model{
		client:    client,
		model:     model,
		store:     store,
		workspace: workspace,
		input:     input,
		events:    make(chan eventMsg, 256),
		blocks:    []block{{kind: blockNotice, text: fmt.Sprintf("Termigo. Model %s. Workspace %s.", model.ID, workspace)}},
	}
	program := tea.NewProgram(m, tea.WithAltScreen())
	m.program = program
	_, err = program.Run()
	return err
}

func (m *Model) Init() tea.Cmd { return textarea.Blink }

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch typed := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = typed.Width
		m.height = typed.Height
		m.input.SetWidth(max(20, typed.Width-4))
		if typed.Height > 10 {
			m.input.SetHeight(3)
		}
		return m, nil

	case eventMsg:
		if typed.done {
			m.running = false
			m.cancel = nil
			return m, nil
		}
		m.appendBlock(typed.kind, typed.text)
		return m, m.waitForEvent()

	case errMsg:
		m.running = false
		m.cancel = nil
		m.appendBlock(blockError, typed.err.Error())
		return m, nil

	case approvalMsg:
		m.pendingTool = typed.tool
		m.pendingDetail = typed.detail
		m.pendingReply = typed.reply
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(typed)
	}
	return m, nil
}

func (m *Model) handleKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	// The model picker is modal: it owns the arrow keys and Enter.
	if m.pickerActive {
		switch key.String() {
		case "up", "ctrl+p":
			if len(m.pickerItems) > 0 {
				m.pickerCursor = (m.pickerCursor - 1 + len(m.pickerItems)) % len(m.pickerItems)
			}
			return m, nil
		case "down", "ctrl+n":
			if len(m.pickerItems) > 0 {
				m.pickerCursor = (m.pickerCursor + 1) % len(m.pickerItems)
			}
			return m, nil
		case "enter":
			if len(m.pickerItems) > 0 {
				chosen := m.pickerItems[m.pickerCursor]
				m.pickerActive = false
				m.setModel(chosen)
			}
			return m, nil
		case "esc":
			m.pickerActive = false
			return m, nil
		}
		return m, nil
	}

	// An approval prompt captures y/n/a first.
	if m.pendingReply != nil {
		switch strings.ToLower(key.String()) {
		case "y", "a":
			m.pendingReply <- true
			m.pendingReply = nil
			m.pendingTool = ""
			return m, nil
		case "n", "esc":
			m.pendingReply <- false
			m.pendingReply = nil
			m.pendingTool = ""
			return m, nil
		}
	}

	switch key.String() {
	case "ctrl+c":
		if m.cancel != nil {
			m.cancel()
		}
		return m, tea.Quit
	case "enter":
		if m.running {
			return m, nil
		}
		value := strings.TrimSpace(m.input.Value())
		if value == "" {
			return m, nil
		}
		m.input.Reset()
		if strings.HasPrefix(value, "/") {
			return m.handleSlash(value)
		}
		return m.startRun(value)
	}

	if m.running {
		return m, nil
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(key)
	return m, cmd
}

func (m *Model) handleSlash(value string) (tea.Model, tea.Cmd) {
	fields := strings.Fields(value)
	switch strings.ToLower(fields[0]) {
	case "/quit", "/exit":
		return m, tea.Quit
	case "/help":
		m.appendBlock(blockNotice, "Commands: /model [query] pick or set the model, /status, /new, /help, /quit. Enter sends, Ctrl+J newline, Esc denies an approval.")
		return m, nil
	case "/model":
		if len(fields) < 2 {
			m.openModelPicker()
			return m, nil
		}
		model, ok := provider.ModelFromQuery(strings.Join(fields[1:], " "))
		if !ok {
			m.appendBlock(blockError, "Unknown model.")
			return m, nil
		}
		m.setModel(model)
		return m, nil
	case "/status":
		m.appendBlock(blockNotice, fmt.Sprintf("model: %s\nworkspace: %s", m.model.ID, m.workspace))
		return m, nil
	case "/new":
		m.blocks = nil
		m.appendBlock(blockNotice, "New session.")
		return m, nil
	default:
		m.appendBlock(blockError, "Unknown command. Try /help.")
		return m, nil
	}
}

// openModelPicker lists the models whose provider has a credential.
func (m *Model) openModelPicker() {
	items := make([]provider.Model, 0, 16)
	for _, model := range provider.Models() {
		if provider.ResolveKey(m.store, model.Provider) != "" {
			items = append(items, model)
		}
	}
	if len(items) == 0 {
		m.appendBlock(blockError, "No provider has a credential; run 'termigo login <provider>' or set a key.")
		return
	}
	m.pickerItems = items
	m.pickerCursor = 0
	m.pickerActive = true
}

// setModel switches the active model and rebuilds its client.
func (m *Model) setModel(model provider.Model) {
	client, err := provider.NewClient(model.Provider, provider.DefaultBaseURL(model.Provider), provider.ResolverFor(m.store))
	if err != nil {
		m.appendBlock(blockError, err.Error())
		return
	}
	provider.SetForceResolver(client, m.store)
	m.client = client
	m.model = model
	m.appendBlock(blockNotice, "Model is now "+model.ID+".")
}

func (m *Model) startRun(prompt string) (tea.Model, tea.Cmd) {
	m.appendBlock(blockUser, prompt)
	m.running = true
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel

	client := m.client
	model := m.model
	workspace := m.workspace
	store := m.store
	events := m.events
	go func() {
		defer func() { events <- eventMsg{done: true} }()
		env := &coder.Env{
			Workspace: workspace,
			Trusted:   true,
			Secrets:   store,
			Approve:   m.approve,
		}
		_, err := coder.Run(ctx, coder.Options{Client: client, Model: model.WireID(), Env: env}, prompt, func(event provider.StreamEvent) {
			switch event.Type {
			case provider.EventTextDelta:
				events <- eventMsg{kind: blockAssistant, text: event.Text}
			case provider.EventReasoningDelta:
				events <- eventMsg{kind: blockReasoning, text: event.Text}
			case provider.EventToolCall:
				if event.ToolCall != nil {
					events <- eventMsg{kind: blockTool, text: event.ToolCall.Name}
				}
			}
		})
		if err != nil {
			events <- eventMsg{kind: blockError, text: err.Error()}
		}
	}()
	return m, m.waitForEvent()
}

func (m *Model) waitForEvent() tea.Cmd {
	events := m.events
	return func() tea.Msg {
		return <-events
	}
}

// approve is called on the agent goroutine and blocks until the operator
// answers in the UI.
func (m *Model) approve(request coder.ApprovalRequest) coder.Decision {
	reply := make(chan bool, 1)
	if m.program == nil {
		return coder.DecisionDeny
	}
	m.program.Send(approvalMsg{tool: request.Tool, detail: request.Detail, reply: reply})
	select {
	case allowed := <-reply:
		if allowed {
			return coder.DecisionAllowOnce
		}
		return coder.DecisionDeny
	case <-time.After(2 * time.Minute):
		return coder.DecisionDeny
	}
}

func (m *Model) appendBlock(kind blockKind, text string) {
	if text == "" {
		return
	}
	// Merge streamed deltas into the open block of the same kind.
	if len(m.blocks) > 0 && (kind == blockAssistant || kind == blockReasoning) {
		last := &m.blocks[len(m.blocks)-1]
		if last.kind == kind {
			last.text += text
			return
		}
	}
	m.blocks = append(m.blocks, block{kind: kind, text: text})
}

func (m *Model) View() string {
	var builder strings.Builder
	for _, entry := range m.blocks {
		switch entry.kind {
		case blockUser:
			builder.WriteString(userStyle.Render("You: ") + entry.text + "\n\n")
		case blockAssistant:
			builder.WriteString(assistantStyle.Render(entry.text) + "\n")
		case blockReasoning:
			builder.WriteString(reasoningStyle.Render(entry.text) + "\n")
		case blockTool:
			builder.WriteString(toolStyle.Render("> "+entry.text) + "\n")
		case blockError:
			builder.WriteString(errorStyle.Render("error: "+entry.text) + "\n")
		case blockNotice:
			builder.WriteString(noticeStyle.Render(entry.text) + "\n")
		}
	}

	if m.pickerActive {
		builder.WriteString("\n" + userStyle.Render("Choose a model (up/down, Enter, Esc):") + "\n")
		for index, item := range m.pickerItems {
			cursor := "  "
			if index == m.pickerCursor {
				cursor = "> "
			}
			builder.WriteString(toolStyle.Render(cursor+item.Label) + statusStyle.Render(" ("+item.Provider+")") + "\n")
		}
	}
	if m.pendingReply != nil {
		builder.WriteString("\n" + toolStyle.Render(fmt.Sprintf("Approve %s? [y]es / [n]o  %s", m.pendingTool, m.pendingDetail)) + "\n")
	}
	if m.running {
		builder.WriteString(statusStyle.Render("working...") + "\n")
	}
	builder.WriteString("\n" + m.input.View())
	return builder.String()
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
