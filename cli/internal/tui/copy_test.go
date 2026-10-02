package tui

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestAssistantTextPicksTheNthMostRecent(t *testing.T) {
	m := &Model{blocks: []block{
		{kind: blockUser, text: "q1"},
		{kind: blockAssistant, text: "a1"},
		{kind: blockTool, text: "read_file"},
		{kind: blockAssistant, text: "a2"},
	}}

	if got, ok := m.assistantText(1); !ok || got != "a2" {
		t.Errorf("last = %q ok=%v, want a2", got, ok)
	}
	if got, ok := m.assistantText(2); !ok || got != "a1" {
		t.Errorf("second last = %q ok=%v, want a1", got, ok)
	}
	if _, ok := m.assistantText(3); ok {
		t.Errorf("a third assistant reply should not exist")
	}
	// A count below one is treated as the last reply.
	if got, ok := m.assistantText(0); !ok || got != "a2" {
		t.Errorf("zero = %q ok=%v, want the last reply", got, ok)
	}
}

func TestOSC52EncodesTheClipboardSequence(t *testing.T) {
	got := osc52("hi")
	want := "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte("hi")) + "\a"
	if got != want {
		t.Errorf("osc52 = %q, want %q", got, want)
	}
	if !strings.HasPrefix(got, "\x1b]52;c;") || !strings.HasSuffix(got, "\a") {
		t.Errorf("osc52 is missing the OSC 52 frame: %q", got)
	}
}
