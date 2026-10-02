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

// TestSettingsShowsAndChangesApproval covers /settings.
func TestSettingsShowsAndChangesApproval(t *testing.T) {
	t.Setenv("TERMIGO_HOME", t.TempDir())
	model := &Model{workspace: "/tmp/x"}
	_, _ = model.handleSlash("/settings")
	if len(model.blocks) == 0 || model.blocks[len(model.blocks)-1].kind != blockNotice {
		t.Fatalf("settings should print a notice, got %+v", model.blocks)
	}
	_, _ = model.handleSlash("/settings approval all")
	if model.approvalMode != "all" {
		t.Errorf("approvalMode = %q, want all", model.approvalMode)
	}
	_, _ = model.handleSlash("/settings approval bogus")
	if model.approvalMode != "all" {
		t.Errorf("a bad value must not change the mode, got %q", model.approvalMode)
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
