package tui

import "testing"

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
