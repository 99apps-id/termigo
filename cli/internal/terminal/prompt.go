package terminal

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// echoOff disables terminal echo and returns a restore function; ok is false
// when echo cannot be controlled (stdin is not a terminal, or the platform has
// no way to ask). A variable so tests can drive both paths without a real
// terminal.
var echoOff = platformEchoOff

// ui is the interactive shell of the terminal surface. Every prompt and every
// line of output goes through it, so a whole session can be scripted in a test
// by handing it a reader.
type ui struct {
	in  *bufio.Reader
	out io.Writer
}

func newUI(in io.Reader, out io.Writer) *ui {
	return &ui{in: bufio.NewReader(in), out: out}
}

func (u *ui) printf(format string, args ...interface{}) {
	_, _ = fmt.Fprintf(u.out, format, args...)
}

func (u *ui) println(text string) {
	u.printf("%s\n", text)
}

// line reads one answer. ok is false at end of input, which is how a closed or
// piped stdin ends the session instead of looping forever.
func (u *ui) line(prompt string) (string, bool) {
	u.printf("%s", prompt)
	text, err := u.in.ReadString('\n')
	if err != nil && text == "" {
		u.println("")
		return "", false
	}
	return strings.TrimSpace(text), true
}

// secret reads a value with terminal echo off.
//
// When echo cannot be disabled the note is printed deliberately: a key typed in
// clear on a shared or recorded screen is a real leak, and silently echoing it
// would hide the reason rather than the key.
func (u *ui) secret(prompt string) (string, bool) {
	restore, masked := echoOff()
	value, ok := u.line(prompt)
	restore()
	u.println("")
	if !masked {
		u.println("note: this terminal cannot hide what you type; the key was visible.")
	}
	return value, ok
}

// choose prints options and reads a 1-based index. A zero result means the user
// cancelled with an empty answer; ok is false at end of input.
func (u *ui) choose(prompt string, options []string) (int, bool) {
	for index, option := range options {
		u.printf("  %d. %s\n", index+1, option)
	}
	for {
		answer, ok := u.line(prompt)
		if !ok {
			return 0, false
		}
		if answer == "" {
			return 0, true
		}
		index, err := strconv.Atoi(answer)
		if err != nil || index < 1 || index > len(options) {
			u.printf("Enter a number from 1 to %d, or press Enter to cancel.\n", len(options))
			continue
		}
		return index, true
	}
}

// confirm reads a yes/no answer. Only an explicit yes counts, so a stray
// keystroke can never overwrite a stored key or loosen an approval gate.
func (u *ui) confirm(prompt string) (bool, bool) {
	answer, ok := u.line(prompt)
	if !ok {
		return false, false
	}
	switch strings.ToLower(answer) {
	case "y", "yes":
		return true, true
	default:
		return false, true
	}
}

// failed reports an app error without ending the session: a mistyped key or a
// stopped app must not close the terminal.
func (u *ui) failed(action string, err error) {
	u.printf("Could not %s: %v\n", action, err)
}

// offlineHint is the one failure a terminal user hits most: the app is not up,
// so there is no control endpoint to talk to.
func (u *ui) offlineHint() {
	u.println("The Termigo app must be running for this to work.")
}
