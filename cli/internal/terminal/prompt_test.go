package terminal

import (
	"bytes"
	"strings"
	"testing"
)

// stubEcho replaces the platform echo control so both paths are reachable in a
// test: the real one needs a terminal and would leave echo off if a test failed
// mid-prompt.
func stubEcho(t *testing.T, masked bool) {
	t.Helper()
	original := echoOff
	echoOff = func() (func(), bool) { return func() {}, masked }
	t.Cleanup(func() { echoOff = original })
}

func TestLineTrimsAndReportsEndOfInput(t *testing.T) {
	ui := newUI(strings.NewReader("  hello world  \r\n"), &bytes.Buffer{})
	answer, ok := ui.line("> ")
	if !ok || answer != "hello world" {
		t.Fatalf("line = %q, ok = %v", answer, ok)
	}

	ui = newUI(strings.NewReader(""), &bytes.Buffer{})
	if _, ok := ui.line("> "); ok {
		t.Fatal("a closed input must end the session, not spin")
	}
}

func TestLineAcceptsAFinalLineWithoutNewline(t *testing.T) {
	// A piped answer often has no trailing newline; dropping it would silently
	// ignore the last value a script sent.
	ui := newUI(strings.NewReader("edits"), &bytes.Buffer{})
	answer, ok := ui.line("> ")
	if !ok || answer != "edits" {
		t.Fatalf("line = %q, ok = %v", answer, ok)
	}
}

func TestSecretDoesNotWarnWhenEchoIsOff(t *testing.T) {
	stubEcho(t, true)
	out := &bytes.Buffer{}
	ui := newUI(strings.NewReader("sk-test\n"), out)
	value, ok := ui.secret("API key: ")
	if !ok || value != "sk-test" {
		t.Fatalf("secret = %q, ok = %v", value, ok)
	}
	if strings.Contains(out.String(), "cannot hide") {
		t.Fatalf("a masked prompt must not warn: %q", out.String())
	}
}

func TestSecretWarnsWhenEchoCannotBeDisabled(t *testing.T) {
	// The warning is the feature: without it the operator believes the key was
	// hidden while it was on screen.
	stubEcho(t, false)
	out := &bytes.Buffer{}
	ui := newUI(strings.NewReader("sk-test\n"), out)
	value, ok := ui.secret("API key: ")
	if !ok || value != "sk-test" {
		t.Fatalf("secret = %q, ok = %v", value, ok)
	}
	if !strings.Contains(out.String(), "cannot hide") {
		t.Fatalf("expected a warning, got: %q", out.String())
	}
}

func TestSecretRestoresEcho(t *testing.T) {
	restored := false
	original := echoOff
	echoOff = func() (func(), bool) {
		return func() { restored = true }, true
	}
	t.Cleanup(func() { echoOff = original })

	newUI(strings.NewReader("sk-test\n"), &bytes.Buffer{}).secret("API key: ")
	if !restored {
		t.Fatal("echo must be restored even though the prompt succeeded, or the whole shell stays silent")
	}
}

func TestChooseRejectsOutOfRangeAndCancelsOnEmpty(t *testing.T) {
	out := &bytes.Buffer{}
	ui := newUI(strings.NewReader("7\n2\n"), out)
	index, ok := ui.choose("Pick: ", []string{"a", "b"})
	if !ok || index != 2 {
		t.Fatalf("choose = %d, ok = %v", index, ok)
	}
	if !strings.Contains(out.String(), "Enter a number from 1 to 2") {
		t.Fatalf("expected a range hint, got: %q", out.String())
	}

	ui = newUI(strings.NewReader("\n"), &bytes.Buffer{})
	index, ok = ui.choose("Pick: ", []string{"a", "b"})
	if !ok || index != 0 {
		t.Fatalf("an empty answer should cancel: %d, %v", index, ok)
	}

	ui = newUI(strings.NewReader("not a number\n1\n"), &bytes.Buffer{})
	if index, ok := ui.choose("Pick: ", []string{"a"}); !ok || index != 1 {
		t.Fatalf("a non-number should be re-asked: %d, %v", index, ok)
	}
}

func TestChooseEndsAtEndOfInput(t *testing.T) {
	ui := newUI(strings.NewReader(""), &bytes.Buffer{})
	if _, ok := ui.choose("Pick: ", []string{"a"}); ok {
		t.Fatal("choose must report the end of input")
	}
}

func TestConfirmNeedsAnExplicitYes(t *testing.T) {
	cases := []struct {
		input string
		want  bool
	}{
		{"y\n", true},
		{"YES\n", true},
		{"n\n", false},
		{"\n", false},
		{"sure\n", false},
	}
	for _, tc := range cases {
		ui := newUI(strings.NewReader(tc.input), &bytes.Buffer{})
		got, ok := ui.confirm("Sure? ")
		if !ok || got != tc.want {
			t.Errorf("confirm(%q) = %v, ok = %v; want %v", tc.input, got, ok, tc.want)
		}
	}
}

func TestFallback(t *testing.T) {
	if fallback("", "none") != "none" || fallback("  ", "none") != "none" {
		t.Error("a blank value should fall back")
	}
	if fallback("ask", "none") != "ask" {
		t.Error("a real value must be kept")
	}
}
