//go:build !windows

package terminal

import (
	"os"
	"os/exec"
)

// platformEchoOff turns terminal echo off with stty.
//
// stty is the portable way to do this without a dependency, and it exits
// non-zero when stdin is not a terminal (a pipe, a file, a minimal container),
// which is exactly the signal the caller needs to warn instead of pretending the
// input is hidden. It has to inherit the real stdin, not a pipe.
func platformEchoOff() (func(), bool) {
	if err := runStty("-echo"); err != nil {
		return func() {}, false
	}
	return func() { _ = runStty("echo") }, true
}

func runStty(arg string) error {
	cmd := exec.Command("stty", arg)
	cmd.Stdin = os.Stdin
	return cmd.Run()
}
