package tui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestAppendBlockMergesStreamedDeltas keeps streamed text in one block instead
// of one block per token.
func TestAppendBlockMergesStreamedDeltas(t *testing.T) {
	model := &Model{}
	model.appendBlock(blockAssistant, "Hel")
	model.appendBlock(blockAssistant, "lo")
	if len(model.blocks) != 1 {
		t.Fatalf("blocks = %d, want 1", len(model.blocks))
	}
	if model.blocks[0].text != "Hello" {
		t.Errorf("text = %q, want Hello", model.blocks[0].text)
	}
}

// TestHandleSlashHelpAddsANotice proves a slash command is handled in the TUI.
func TestHandleSlashHelpAddsANotice(t *testing.T) {
	model := &Model{}
	_, _ = model.handleSlash("/help")
	if len(model.blocks) != 1 || model.blocks[0].kind != blockNotice {
		t.Fatalf("blocks = %+v, want one notice", model.blocks)
	}
}

// TestHandleSlashUnknownReportsAnError proves an unknown command is surfaced.
func TestHandleSlashUnknownReportsAnError(t *testing.T) {
	model := &Model{}
	_, _ = model.handleSlash("/nope")
	if len(model.blocks) != 1 || model.blocks[0].kind != blockError {
		t.Fatalf("blocks = %+v, want one error", model.blocks)
	}
}

// TestModelPickerSwitchesTheModel proves a bare /model opens a list and Enter
// selects from it, which is the menu-style model choice.
func TestModelPickerSwitchesTheModel(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	model := &Model{}
	model.openModelPicker()
	if !model.pickerActive || len(model.pickerItems) == 0 {
		t.Fatalf("picker active=%v items=%d, want an open list", model.pickerActive, len(model.pickerItems))
	}
	want := model.pickerItems[0].ID
	updated, _ := model.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	got := updated.(*Model)
	if got.pickerActive {
		t.Errorf("the picker should close after a choice")
	}
	if got.model.ID != want {
		t.Errorf("model = %q, want %q", got.model.ID, want)
	}
}

// TestSlashNewClearsTheTranscript covers /new.
func TestSlashNewClearsTheTranscript(t *testing.T) {
	model := &Model{blocks: []block{{kind: blockAssistant, text: "old"}}}
	_, _ = model.handleSlash("/new")
	if len(model.blocks) != 1 || model.blocks[0].kind != blockNotice {
		t.Fatalf("blocks = %+v, want a fresh session notice", model.blocks)
	}
}
