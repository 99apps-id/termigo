//go:build windows

package terminal

import (
	"syscall"
	"unsafe"
)

// enableEchoInput is ENABLE_ECHO_INPUT from the Windows console API.
const enableEchoInput = 0x0004

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	procGetConsoleMode = kernel32.NewProc("GetConsoleMode")
	procSetConsoleMode = kernel32.NewProc("SetConsoleMode")
)

// platformEchoOff clears ENABLE_ECHO_INPUT on the console input handle.
//
// GetConsoleMode fails when stdin is a pipe or a file, which is the signal that
// masking is impossible here and the caller has to warn; there is no way to hide
// input that is not going through a console.
func platformEchoOff() (func(), bool) {
	handle, err := syscall.GetStdHandle(syscall.STD_INPUT_HANDLE)
	if err != nil {
		return func() {}, false
	}
	var mode uint32
	if ok, _, _ := procGetConsoleMode.Call(uintptr(handle), uintptr(unsafe.Pointer(&mode))); ok == 0 {
		return func() {}, false
	}
	if mode&enableEchoInput == 0 {
		// Echo is already off (a previous run died without restoring it); there
		// is nothing to restore either.
		return func() {}, true
	}
	if ok, _, _ := procSetConsoleMode.Call(uintptr(handle), uintptr(mode&^enableEchoInput)); ok == 0 {
		return func() {}, false
	}
	original := mode
	return func() {
		_, _, _ = procSetConsoleMode.Call(uintptr(handle), uintptr(original))
	}, true
}
