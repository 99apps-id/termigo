// Package tui is the interactive Bubble Tea front end for the Termigo agent:
// a scrolling transcript, a prompt, streamed thinking and tool calls, and an
// inline approval prompt.
package tui

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/99apps-id/termigo/cli/internal/coder"
	"github.com/99apps-id/termigo/cli/internal/config"
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
	session   *coder.Session

	cfg          config.Config
	approvalMode string
	trusted      bool

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

	// picker selects a provider then a model, opened by a bare /model.
	pickerActive    bool
	pickerStage     int // 0 provider, 1 model
	pickerProviders []provider.Provider
	pickerModels    []provider.Model
	pickerCursor    int
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

// Run starts the TUI and blocks until the operator quits. session may be nil,
// in which case a fresh one is started for the workspace.
func Run(store *secrets.Store, workspace string, model provider.Model, session *coder.Session) error {
	client, err := provider.NewClient(model.Provider, provider.DefaultBaseURL(model.Provider), provider.ResolverFor(store))
	if err != nil {
		return err
	}
	provider.SetForceResolver(client, store)

	input := textarea.New()
	input.Placeholder = "Ask, or type /help. Enter to send, Ctrl+J for a newline."
	input.Focus()

	if session == nil {
		session = coder.NewSession(workspace, model.WireID())
	}
	cfg, _ := config.Load()
	m := &Model{
		client:       client,
		model:        model,
		store:        store,
		workspace:    workspace,
		session:      session,
		cfg:          cfg,
		approvalMode: strings.ToLower(strings.TrimSpace(cfg.ApprovalMode)),
		trusted:      cfg.IsTrusted(workspace),
		input:        input,
		events:       make(chan eventMsg, 256),
		blocks:       []block{{kind: blockNotice, text: fmt.Sprintf("Termigo. Model %s. Workspace %s. Session %s. /help for commands.", model.ID, workspace, session.ID)}},
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
		return m.handlePickerKey(key), nil
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
	case "ctrl+y":
		m.copyReply(1)
		return m, nil
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
		m.appendBlock(blockNotice, "Commands: /model [query] pick provider then model, /providers, /settings [key value], /status, /sessions, /copy [n], /new, /help, /quit. Enter sends, Ctrl+J newline, Ctrl+Y copies the last reply, Esc denies an approval. Start with --continue to resume the last session.")
		return m, nil
	case "/settings":
		return m.handleSettings(fields), nil
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
		m.appendBlock(blockNotice, fmt.Sprintf("model: %s\nworkspace: %s\nsession: %s\nturns: %d", m.model.ID, m.workspace, m.session.ID, len(m.session.Messages)/2))
		return m, nil
	case "/providers":
		m.appendBlock(blockNotice, m.providersStatus())
		return m, nil
	case "/sessions":
		m.appendBlock(blockNotice, m.sessionsList())
		return m, nil
	case "/copy":
		which := 1
		if len(fields) > 1 {
			if n, err := strconv.Atoi(fields[1]); err == nil && n > 0 {
				which = n
			}
		}
		m.copyReply(which)
		return m, nil
	case "/new":
		m.blocks = nil
		m.session = coder.NewSession(m.workspace, m.model.WireID())
		if err := m.session.Save(); err != nil {
			m.appendBlock(blockError, err.Error())
			return m, nil
		}
		m.appendBlock(blockNotice, "New session "+m.session.ID+".")
		return m, nil
	default:
		m.appendBlock(blockError, "Unknown command. Try /help.")
		return m, nil
	}
}

// handleSettings shows the CLI settings, or changes one with
// "/settings <key> <value>".
func (m *Model) handleSettings(fields []string) tea.Model {
	if len(fields) == 1 {
		approval := m.approvalMode
		if approval == "" {
			approval = "ask"
		}
		m.appendBlock(blockNotice, fmt.Sprintf(
			"model: %s\nworkspace: %s\napproval: %s (ask|all)\ntrusted: %v (trust on|off)\nlanguage: %s",
			m.model.ID, m.workspace, approval, m.trusted, m.cfg.Language))
		return m
	}
	key := strings.ToLower(fields[1])
	value := strings.Join(fields[2:], " ")
	switch key {
	case "approval":
		if value != "ask" && value != "all" {
			m.appendBlock(blockError, "approval must be ask or all")
			return m
		}
		m.approvalMode = value
		m.cfg.ApprovalMode = value
	case "trust":
		on := value == "on" || value == "yes" || value == "true"
		m.trusted = on
		m.cfg = m.cfg.WithTrust(m.workspace, on)
	case "language":
		m.cfg.Language = value
	case "model":
		if model, ok := provider.ModelFromQuery(value); ok {
			m.setModel(model)
			m.cfg.DefaultModel = model.ID
		} else {
			m.appendBlock(blockError, "Unknown model.")
			return m
		}
	default:
		m.appendBlock(blockError, "Unknown setting. Try approval, trust, language or model.")
		return m
	}
	if err := config.Save(m.cfg); err != nil {
		m.appendBlock(blockError, err.Error())
		return m
	}
	m.appendBlock(blockNotice, "Setting saved.")
	return m
}

// openModelPicker lists the providers with a credential, then their models.
func (m *Model) openModelPicker() {
	providers := make([]provider.Provider, 0, 16)
	for _, info := range provider.Providers() {
		if len(provider.ModelsFor(info.ID)) == 0 {
			continue
		}
		if info.ID != m.model.Provider && provider.ResolveKey(m.store, info.ID) == "" {
			continue
		}
		providers = append(providers, info)
	}
	if len(providers) == 0 {
		m.appendBlock(blockError, "No provider has a credential; run 'termigo login <provider>' or set a key.")
		return
	}
	m.pickerProviders = providers
	m.pickerStage = 0
	m.pickerCursor = 0
	m.pickerActive = true
}

func (m *Model) pickerCount() int {
	if m.pickerStage == 0 {
		return len(m.pickerProviders)
	}
	return len(m.pickerModels)
}

// handlePickerKey drives the two-step provider then model picker.
func (m *Model) handlePickerKey(key tea.KeyMsg) tea.Model {
	count := m.pickerCount()
	switch key.String() {
	case "up", "ctrl+p":
		if count > 0 {
			m.pickerCursor = (m.pickerCursor - 1 + count) % count
		}
	case "down", "ctrl+n":
		if count > 0 {
			m.pickerCursor = (m.pickerCursor + 1) % count
		}
	case "enter":
		if count == 0 {
			return m
		}
		if m.pickerStage == 0 {
			chosen := m.pickerProviders[m.pickerCursor]
			m.pickerModels = provider.ModelsFor(chosen.ID)
			m.pickerStage = 1
			m.pickerCursor = 0
			return m
		}
		chosen := m.pickerModels[m.pickerCursor]
		m.pickerActive = false
		m.setModel(chosen)
	case "esc":
		if m.pickerStage == 1 {
			m.pickerStage = 0
			m.pickerCursor = 0
			return m
		}
		m.pickerActive = false
	}
	return m
}

// sessionsList renders this workspace's recent sessions, newest first, with the
// current one marked. The id is what `termigo chat --session <id>` takes.
func (m *Model) sessionsList() string {
	sessions, err := coder.ListSessions(m.workspace)
	if err != nil {
		return "error: " + err.Error()
	}
	if len(sessions) == 0 {
		return "No sessions for this workspace yet."
	}
	var builder strings.Builder
	for index, session := range sessions {
		if index == 15 {
			fmt.Fprintf(&builder, "  ... %d more\n", len(sessions)-index)
			break
		}
		marker := "  "
		if m.session != nil && session.ID == m.session.ID {
			marker = "* "
		}
		fmt.Fprintf(&builder, "%s%s  %s  %s\n", marker, session.ID, session.UpdatedAt.Format("2006-01-02 15:04"), session.Title)
	}
	return strings.TrimRight(builder.String(), "\n")
}

// copyReply copies the n-th most recent assistant reply (1 = last) to the
// terminal clipboard with OSC 52.
func (m *Model) copyReply(which int) {
	text, ok := m.assistantText(which)
	if !ok {
		m.appendBlock(blockError, "Nothing to copy yet.")
		return
	}
	_, _ = os.Stdout.WriteString(osc52(text))
	m.appendBlock(blockNotice, fmt.Sprintf("Copied %d characters to the clipboard.", len(text)))
}

// assistantText returns the text of the n-th most recent assistant block.
func (m *Model) assistantText(which int) (string, bool) {
	if which <= 0 {
		which = 1
	}
	count := 0
	for index := len(m.blocks) - 1; index >= 0; index-- {
		if m.blocks[index].kind != blockAssistant {
			continue
		}
		count++
		if count == which {
			return m.blocks[index].text, true
		}
	}
	return "", false
}

// osc52 is the escape sequence that sets the terminal's clipboard. It is the
// one clipboard path that works over SSH, where there is no local clipboard,
// and in a Windows Terminal. A terminal that ignores it just copies nothing.
func osc52(text string) string {
	return "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte(text)) + "\a"
}

// providersStatus renders a one-line-per-provider credential summary.
func (m *Model) providersStatus() string {
	var builder strings.Builder
	for _, info := range provider.Providers() {
		if len(provider.ModelsFor(info.ID)) == 0 {
			continue
		}
		status := "no credential"
		switch {
		case info.ID == m.model.Provider:
			status = "current"
		case provider.ResolveKey(m.store, info.ID) != "":
			if info.OAuth {
				status = "login"
			} else {
				status = "key"
			}
		}
		fmt.Fprintf(&builder, "%-18s %-14s %s\n", info.ID, info.Label, status)
	}
	return strings.TrimRight(builder.String(), "\n")
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
	if m.session != nil {
		m.session.Model = model.WireID()
		_ = m.session.Save()
	}
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
	session := m.session
	events := m.events
	trusted := m.trusted
	approve := m.approve
	if m.approvalMode == "all" {
		approve = func(coder.ApprovalRequest) coder.Decision { return coder.DecisionAllowOnce }
	}
	go func() {
		defer func() { events <- eventMsg{done: true} }()
		env := &coder.Env{
			Workspace: workspace,
			Trusted:   trusted,
			Secrets:   store,
			Approve:   approve,
		}
		_, err := coder.Run(ctx, coder.Options{Client: client, Model: model.WireID(), Env: env, Session: session}, prompt, func(event provider.StreamEvent) {
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
		_ = session.Save()
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
		if m.pickerStage == 0 {
			builder.WriteString("\n" + userStyle.Render("Choose a provider (up/down, Enter, Esc):") + "\n")
			for index, info := range m.pickerProviders {
				cursor := "  "
				if index == m.pickerCursor {
					cursor = "> "
				}
				builder.WriteString(toolStyle.Render(cursor+info.Label) + statusStyle.Render(" ("+info.ID+")") + "\n")
			}
		} else {
			builder.WriteString("\n" + userStyle.Render("Choose a model (up/down, Enter, Esc back):") + "\n")
			for index, item := range m.pickerModels {
				cursor := "  "
				if index == m.pickerCursor {
					cursor = "> "
				}
				builder.WriteString(toolStyle.Render(cursor+item.Label) + statusStyle.Render(" ("+item.ID+")") + "\n")
			}
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
