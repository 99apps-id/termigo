package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func typeText(m *Model, text string) {
	m.input.Focus()
	for _, r := range text {
		m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
}

func TestSlashMenuFiltersAndCompletes(t *testing.T) {
	m := newModel()
	typeText(m, "/mo")
	if len(m.menu) != 1 || m.menu[0].label != "/model" {
		t.Fatalf("menu = %+v", m.menu)
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyTab})
	if m.input.Value() != "/model " {
		t.Fatalf("tab should complete the command, got %q", m.input.Value())
	}
	if len(m.menu) != 0 {
		t.Fatal("the menu closes once an argument can be typed")
	}
}

// A command typed out in full runs on Enter; a partial one completes first.
func TestEnterCompletesAPartialCommandAndRunsAFullOne(t *testing.T) {
	m := newModel()
	typeText(m, "/he")
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if m.input.Value() != "/help " || len(m.blocks) != 0 {
		t.Fatalf("first Enter completes: value=%q blocks=%d", m.input.Value(), len(m.blocks))
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if !strings.Contains(lastNotice(m), "Commands:") {
		t.Fatalf("second Enter runs /help, got %q", lastNotice(m))
	}
}

func TestMenuEscClosesItAndArrowsMoveTheCursor(t *testing.T) {
	m := newModel()
	typeText(m, "/")
	if len(m.menu) != maxMenuRows {
		t.Fatalf("rows are capped, got %d", len(m.menu))
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyDown})
	if m.menuCursor != 1 {
		t.Fatalf("cursor = %d", m.menuCursor)
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
	if len(m.menu) != 0 || m.input.Value() != "/" {
		t.Fatal("Esc closes the menu and keeps the text")
	}
}

func TestNoCommandMenuWhileARunWorks(t *testing.T) {
	m := newModel()
	m.running = true
	typeText(m, "/n")
	if len(m.menu) != 0 {
		t.Fatal("commands wait for the run, so they are not offered")
	}
}

func workspaceWith(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestFileMenuRanksNamesAndSkipsDependencyDirs(t *testing.T) {
	root := workspaceWith(t, map[string]string{
		"main.go":                  "package main",
		"internal/maintain.go":     "x",
		"docs/domain.md":           "x",
		"node_modules/pkg/main.js": "x",
		".git/config":              "x",
	})
	m := newModel()
	m.workspace = root
	typeText(m, "look at @main")
	var labels []string
	for _, row := range m.menu {
		labels = append(labels, row.label)
	}
	want := []string{"main.go", "internal/maintain.go", "docs/domain.md"}
	if strings.Join(labels, ",") != strings.Join(want, ",") {
		t.Fatalf("ranking = %q", labels)
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyTab})
	if m.input.Value() != "look at @main.go " {
		t.Fatalf("completion = %q", m.input.Value())
	}
}

func TestAtSignInsideAWordIsNotAMention(t *testing.T) {
	if kind, _, _ := completion("mail me@example", []string{"example.go"}); kind != menuNone {
		t.Fatal("an @ inside a word must not open the file menu")
	}
}

func TestExpandMentionsAttachesFilesInsideTheWorkspaceOnly(t *testing.T) {
	root := workspaceWith(t, map[string]string{"a.txt": "hello", "bin.dat": "ab\x00cd"})
	outside := filepath.Join(filepath.Dir(root), "secret-"+filepath.Base(root))
	if err := os.WriteFile(outside, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(outside)

	prompt := "read @a.txt, and @bin.dat and @missing.go and @../" + filepath.Base(outside) + " and @a.txt"
	sent, attached := expandMentions(prompt, root)
	if len(attached) != 1 || attached[0] != "a.txt" {
		t.Fatalf("attached = %q", attached)
	}
	if !strings.Contains(sent, "<file path=\"a.txt\">\nhello\n</file>") || strings.Contains(sent, "nope") || strings.Contains(sent, "ab\x00") {
		t.Fatalf("sent = %q", sent)
	}
	if strings.Count(sent, "<file path=") != 1 {
		t.Fatal("a file named twice is attached once")
	}
}

func TestExpandMentionsTruncatesLargeFiles(t *testing.T) {
	root := workspaceWith(t, map[string]string{"big.txt": strings.Repeat("x", maxMentionBytes+100)})
	sent, _ := expandMentions("@big.txt", root)
	if !strings.Contains(sent, "[truncated at 64 KB]") || len(sent) > maxMentionBytes+200 {
		t.Fatalf("a large file is cut and says so (len %d)", len(sent))
	}
}

// The transcript shows what was typed; the model gets the file as well.
func TestSendingAMentionShowsTheTextAndNamesTheFile(t *testing.T) {
	root := workspaceWith(t, map[string]string{"a.txt": "hello"})
	m := newModel()
	m.workspace = root
	m.running = true
	typeText(m, "fix @a.txt")
	m.handleKey(tea.KeyMsg{Type: tea.KeyTab})
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	queued := m.takeSteer()
	if len(queued) != 1 || !strings.Contains(queued[0], "hello") {
		t.Fatalf("the model should get the file: %q", queued)
	}
	if !strings.Contains(lastNotice(m), "Attached: a.txt") {
		t.Fatalf("the operator is told what went along: %q", lastNotice(m))
	}
}

func TestUpAndDownWalkSentHistoryAndKeepTheDraft(t *testing.T) {
	m := newModel()
	m.running = true
	for _, line := range []string{"first", "second"} {
		typeText(m, line)
		m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	}
	typeText(m, "draft")
	m.handleKey(tea.KeyMsg{Type: tea.KeyUp})
	if m.input.Value() != "second" {
		t.Fatalf("up = %q", m.input.Value())
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyUp})
	if m.input.Value() != "first" {
		t.Fatalf("up = %q", m.input.Value())
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyDown})
	m.handleKey(tea.KeyMsg{Type: tea.KeyDown})
	if m.input.Value() != "draft" {
		t.Fatalf("the unsent draft comes back, got %q", m.input.Value())
	}
}
