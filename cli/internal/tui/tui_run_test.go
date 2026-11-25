package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

func newModel() *Model {
	return &Model{
		input:    textarea.New(),
		viewport: viewport.New(0, 0),
		events:   make(chan eventMsg, 8),
	}
}

func isQuit(cmd tea.Cmd) bool {
	if cmd == nil {
		return false
	}
	_, quit := cmd().(tea.QuitMsg)
	return quit
}

func lastNotice(m *Model) string {
	for index := len(m.blocks) - 1; index >= 0; index-- {
		if m.blocks[index].kind == blockNotice {
			return m.blocks[index].text
		}
	}
	return ""
}

// Ctrl+C stops a run in flight instead of quitting the program, which used to
// end the TUI mid-turn and could lose the turn's session save.
func TestCtrlCInterruptsARunWithoutQuitting(t *testing.T) {
	m := newModel()
	m.running = true
	cancelled := false
	m.cancel = func() { cancelled = true }

	_, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC})
	if isQuit(cmd) {
		t.Fatal("Ctrl+C during a run must not quit the program")
	}
	if !cancelled || !m.interrupted {
		t.Fatalf("the run should be cancelled: cancelled=%v interrupted=%v", cancelled, m.interrupted)
	}

	m.update(eventMsg{done: true})
	if m.running || lastNotice(m) != "Interrupted." {
		t.Fatalf("the transcript should say so once: running=%v notice=%q", m.running, lastNotice(m))
	}
}

func TestEscInterruptsARun(t *testing.T) {
	m := newModel()
	m.running = true
	cancelled := false
	m.cancel = func() { cancelled = true }
	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
	if !cancelled {
		t.Fatal("Esc should interrupt the run")
	}
}

// An idle Ctrl+C clears a draft first; only an empty prompt quits, on the
// second press.
func TestCtrlCQuitsOnlyFromAnEmptyPromptOnTheSecondPress(t *testing.T) {
	m := newModel()
	m.input.SetValue("half a thought")
	if _, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC}); isQuit(cmd) || m.input.Value() != "" {
		t.Fatalf("the first press clears the draft: quit=%v value=%q", isQuit(cmd), m.input.Value())
	}
	if _, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC}); isQuit(cmd) {
		t.Fatal("a single press on an empty prompt must only arm the quit")
	}
	if !strings.Contains(lastNotice(m), "again to quit") {
		t.Fatalf("the operator should be told, got %q", lastNotice(m))
	}
	if _, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC}); !isQuit(cmd) {
		t.Fatal("the second press should quit")
	}
}

// A plain message typed while a run works is queued for it; a slash command
// waits, because it would change state the run is using.
func TestEnterDuringARunQueuesAMessageAndRefusesACommand(t *testing.T) {
	m := newModel()
	m.running = true
	m.input.SetValue("also add tests")
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m.takeSteer(); len(got) != 1 || got[0] != "also add tests" {
		t.Fatalf("queued = %q", got)
	}
	if m.input.Value() != "" {
		t.Fatal("a queued message leaves the composer")
	}

	m.input.SetValue("/new")
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m.takeSteer(); len(got) != 0 {
		t.Fatalf("a command is never queued, got %q", got)
	}
	if m.input.Value() != "/new" {
		t.Fatal("a refused command stays in the composer")
	}
}

// An interrupt is the operator's decision to stop: what they had queued for
// the run is dropped rather than started as a new turn behind their back.
func TestInterruptDropsQueuedMessages(t *testing.T) {
	m := newModel()
	m.running = true
	m.cancel = func() {}
	m.queueSteer("queued")
	m.interrupt()
	m.update(eventMsg{done: true})
	if m.running || len(m.takeSteer()) != 0 {
		t.Fatal("nothing should run after an interrupt")
	}
}

// Every line of the transcript fits the terminal. A line the terminal has to
// wrap itself makes the renderer miscount rows and leaves stale lines behind.
func TestTranscriptLinesNeverExceedTheWidth(t *testing.T) {
	m := newModel()
	m.width = 40
	long := strings.Repeat("word ", 40)
	m.appendBlock(blockUser, long)
	m.appendBlock(blockAssistant, long)
	m.appendBlock(blockTool, long)
	m.appendBlock(blockError, long)
	m.appendBlock(blockNotice, long)
	for _, line := range strings.Split(m.content(), "\n") {
		if width := lipgloss.Width(line); width > 39 {
			t.Fatalf("a %d column line in a 40 column terminal: %q", width, line)
		}
	}
}

func TestThinkingIsOneLineUntilOpened(t *testing.T) {
	m := newModel()
	m.appendBlock(blockReasoning, "secret chain of thought")
	if got := m.content(); strings.Contains(got, "secret chain") || !strings.Contains(got, "Thought") {
		t.Fatalf("collapsed thinking should be one line:\n%s", got)
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlO})
	if !strings.Contains(m.content(), "secret chain of thought") {
		t.Fatal("Ctrl+O should open the thinking")
	}
}

func TestStatusLineShowsContextFillAndBilledTokens(t *testing.T) {
	m := newModel()
	m.model = provider.Model{ID: "test-model"}
	if line := m.statusLine(); strings.Contains(line, "ctx") || strings.Contains(line, "billed") {
		t.Fatalf("a fresh session has nothing to report: %q", line)
	}
	m.update(eventMsg{usage: &provider.Usage{PromptTokens: 12400, CompletionTokens: 90, TotalTokens: 12490}})
	if line := m.statusLine(); !strings.Contains(line, "ctx 12.4k") {
		t.Fatalf("context fill should show: %q", line)
	}
}

func TestPageKeysScrollTheTranscript(t *testing.T) {
	m := newModel()
	m.width, m.height = 40, 14
	m.layout()
	for index := 0; index < 60; index++ {
		m.appendBlock(blockNotice, "line")
	}
	m.refresh()
	if !m.viewport.AtBottom() {
		t.Fatal("a growing transcript follows the bottom")
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyPgUp})
	if m.viewport.AtBottom() {
		t.Fatal("PgUp should scroll back")
	}
	before := m.viewport.YOffset
	m.appendBlock(blockNotice, "new line")
	m.refresh()
	if m.viewport.YOffset != before {
		t.Fatal("new output must not yank a reader away from where they scrolled")
	}
}
