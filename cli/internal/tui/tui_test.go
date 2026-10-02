package tui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/99apps-id/termigo/cli/internal/coder"
)

// coderApprovalRequest builds the request approve() receives, so the tests
// speak the real type instead of a hand-rolled struct that could drift.
func coderApprovalRequest(tool string) coder.ApprovalRequest {
	return coder.ApprovalRequest{Tool: tool, Risk: "edit"}
}

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
	if !model.pickerActive || len(model.pickerProviders) == 0 {
		t.Fatalf("picker active=%v providers=%d, want an open provider list", model.pickerActive, len(model.pickerProviders))
	}

	// First Enter picks the provider, opening its model list.
	updated, _ := model.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	got := updated.(*Model)
	if got.pickerStage != 1 || len(got.pickerModels) == 0 {
		t.Fatalf("stage=%d models=%d, want the model list", got.pickerStage, len(got.pickerModels))
	}
	want := got.pickerModels[0].ID

	// Second Enter picks the model.
	updated2, _ := got.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	final := updated2.(*Model)
	if final.pickerActive {
		t.Errorf("the picker should close after a choice")
	}
	if final.model.ID != want {
		t.Errorf("model = %q, want %q", final.model.ID, want)
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

// TestApprovalSessionKeyRecordsTheAllowance proves the s key answers the
// pending prompt and remembers the tool for the rest of the session, so a
// later approve() for the same tool no longer prompts.
func TestApprovalSessionKeyRecordsTheAllowance(t *testing.T) {
	model := &Model{sessionAllowed: map[string]bool{}}
	reply := make(chan decisionReply, 1)
	model.pendingReply = reply
	model.pendingTool = "edit"

	updated, _ := model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}})
	m := updated.(*Model)
	if m.pendingReply != nil {
		t.Fatal("the prompt should close after an answer")
	}
	select {
	case answer := <-reply:
		if answer != decisionAllowSession {
			t.Fatalf("reply = %v, want decisionAllowSession", answer)
		}
	default:
		t.Fatal("the reply never arrived")
	}
	if !m.sessionAllowed["edit"] {
		t.Fatal("the tool should be remembered for the session")
	}

	// The remembered tool answers the next call without a prompt.
	if decision := m.approve(coderApprovalRequest("edit")); decision != coder.DecisionAllowSession {
		t.Fatalf("approve on a session-allowed tool = %v, want the session decision", decision)
	}
}

// TestApprovalOnceKeyDoesNotWiden proves the y (and legacy a) key answers once
// without recording a session allowance: the operator asked for one call, not
// a standing permission.
func TestApprovalOnceKeyDoesNotWiden(t *testing.T) {
	for _, key := range []rune{'y', 'a'} {
		model := &Model{sessionAllowed: map[string]bool{}}
		reply := make(chan decisionReply, 1)
		model.pendingReply = reply
		model.pendingTool = "run_command"

		updated, _ := model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{key}})
		m := updated.(*Model)
		select {
		case answer := <-reply:
			if answer != decisionAllowOnce {
				t.Fatalf("key %q replied %v, want decisionAllowOnce", key, answer)
			}
		default:
			t.Fatalf("key %q never replied", key)
		}
		if len(m.sessionAllowed) != 0 {
			t.Fatalf("key %q widened the session allowance to %v", key, m.sessionAllowed)
		}
	}
}

// TestApprovalDenyKeyClosesThePrompt proves n and Esc deny without any
// allowance.
func TestApprovalDenyKeyClosesThePrompt(t *testing.T) {
	keys := []tea.KeyMsg{
		{Type: tea.KeyRunes, Runes: []rune{'n'}},
		{Type: tea.KeyEsc},
	}
	for _, key := range keys {
		model := &Model{sessionAllowed: map[string]bool{}}
		reply := make(chan decisionReply, 1)
		model.pendingReply = reply
		model.pendingTool = "delete_file"

		updated, _ := model.handleKey(key)
		m := updated.(*Model)
		if m.pendingReply != nil {
			t.Fatalf("key %q left the prompt open", key.String())
		}
		select {
		case answer := <-reply:
			if answer != decisionDeny {
				t.Fatalf("key %q replied %v, want decisionDeny", key.String(), answer)
			}
		default:
			t.Fatalf("key %q never replied", key.String())
		}
	}
}

// TestSlashNewDropsSessionAllowances proves /new clears the trust scope: a
// tool allowed for the previous task must prompt again in a fresh session.
func TestSlashNewDropsSessionAllowances(t *testing.T) {
	t.Setenv("TERMIGO_HOME", t.TempDir())
	model := &Model{
		workspace:      t.TempDir(),
		sessionAllowed: map[string]bool{"edit": true},
		blocks:         []block{{kind: blockAssistant, text: "old"}},
	}
	_, _ = model.handleSlash("/new")
	if len(model.sessionAllowed) != 0 {
		t.Fatalf("/new kept the session allowances: %v", model.sessionAllowed)
	}
}
