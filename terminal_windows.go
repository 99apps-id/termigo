//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

const (
	terminalOutputEvent = "termigo:terminal-output"
	terminalExitEvent   = "termigo:terminal-exit"
	maxTerminalColumns  = 500
	maxTerminalRows     = 500
	maxTerminalInput    = 64 * 1024
)

var updateProcThreadAttribute = windows.NewLazySystemDLL("kernel32.dll").NewProc("UpdateProcThreadAttribute")

type TerminalSessionInfo struct {
	ID string `json:"id"`
}

type TerminalOutput struct {
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

type TerminalExit struct {
	SessionID string `json:"sessionId"`
	ExitCode  int    `json:"exitCode"`
}

type terminalSession struct {
	id        string
	console   windows.Handle
	process   windows.Handle
	input     *os.File
	output    *os.File
	writeMu   sync.Mutex
	closeOnce sync.Once
}

// StartTerminal opens one interactive cmd.exe session for the active workspace.
// It accepts only data typed in the visible terminal surface; agent execution is
// deliberately not part of this API.
func (a *App) StartTerminal(columns, rows int) (TerminalSessionInfo, error) {
	if err := validateTerminalDimensions(columns, rows); err != nil {
		return TerminalSessionInfo{}, err
	}

	workspace := a.workspacePath()
	if workspace == "" {
		return TerminalSessionInfo{}, errors.New("open a workspace before starting a terminal")
	}

	a.terminalMu.Lock()
	defer a.terminalMu.Unlock()
	if a.terminal != nil {
		if err := a.terminal.resize(columns, rows); err != nil {
			return TerminalSessionInfo{}, err
		}
		return TerminalSessionInfo{ID: a.terminal.id}, nil
	}

	a.terminalSequence++
	sessionID := fmt.Sprintf("terminal-%d", a.terminalSequence)
	session, err := newTerminalSession(sessionID, workspace, columns, rows)
	if err != nil {
		return TerminalSessionInfo{}, err
	}
	a.terminal = session
	session.start(
		func(data string) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, terminalOutputEvent, TerminalOutput{SessionID: sessionID, Data: data})
			}
		},
		func(exitCode int) {
			a.terminalExited(sessionID, exitCode)
		},
	)

	return TerminalSessionInfo{ID: sessionID}, nil
}

func (a *App) WriteTerminal(sessionID, data string) error {
	if data == "" {
		return nil
	}
	if len(data) > maxTerminalInput {
		return fmt.Errorf("terminal input is limited to %d bytes per event", maxTerminalInput)
	}

	session, err := a.terminalByID(sessionID)
	if err != nil {
		return err
	}
	return session.write(data)
}

func (a *App) ResizeTerminal(sessionID string, columns, rows int) error {
	if err := validateTerminalDimensions(columns, rows); err != nil {
		return err
	}
	session, err := a.terminalByID(sessionID)
	if err != nil {
		return err
	}
	return session.resize(columns, rows)
}

func (a *App) StopTerminal(sessionID string) {
	a.stopTerminal(sessionID)
}

func (a *App) stopTerminal(sessionID string) {
	a.terminalMu.Lock()
	defer a.terminalMu.Unlock()
	if a.terminal == nil || (sessionID != "" && a.terminal.id != sessionID) {
		return
	}

	session := a.terminal
	a.terminal = nil
	session.close()
}

func (a *App) terminalByID(sessionID string) (*terminalSession, error) {
	a.terminalMu.Lock()
	defer a.terminalMu.Unlock()
	if a.terminal == nil || a.terminal.id != sessionID {
		return nil, errors.New("terminal session is no longer active")
	}
	return a.terminal, nil
}

func (a *App) terminalExited(sessionID string, exitCode int) {
	a.terminalMu.Lock()
	if a.terminal != nil && a.terminal.id == sessionID {
		a.terminal = nil
	}
	a.terminalMu.Unlock()
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, terminalExitEvent, TerminalExit{SessionID: sessionID, ExitCode: exitCode})
	}
}

func validateTerminalDimensions(columns, rows int) error {
	if columns < 2 || columns > maxTerminalColumns || rows < 2 || rows > maxTerminalRows {
		return fmt.Errorf("terminal size must be between 2x2 and %dx%d", maxTerminalColumns, maxTerminalRows)
	}
	return nil
}

func newTerminalSession(id, workspace string, columns, rows int) (*terminalSession, error) {
	inputRead, inputWrite, err := newSynchronousPipe("termigo-input")
	if err != nil {
		return nil, fmt.Errorf("create terminal input pipe: %w", err)
	}
	outputRead, outputWrite, err := newSynchronousPipe("termigo-output")
	if err != nil {
		inputRead.Close()
		inputWrite.Close()
		return nil, fmt.Errorf("create terminal output pipe: %w", err)
	}

	var pseudoConsole windows.Handle
	coordinate := windows.Coord{X: int16(columns), Y: int16(rows)}
	if err := windows.CreatePseudoConsole(coordinate, windows.Handle(inputRead.Fd()), windows.Handle(outputWrite.Fd()), 0, &pseudoConsole); err != nil {
		inputRead.Close()
		inputWrite.Close()
		outputRead.Close()
		outputWrite.Close()
		return nil, fmt.Errorf("create Windows terminal session (requires Windows 10 version 1809 or newer): %w", err)
	}

	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.ClosePseudoConsole(pseudoConsole)
		inputRead.Close()
		inputWrite.Close()
		outputRead.Close()
		outputWrite.Close()
		return nil, fmt.Errorf("create terminal process attributes: %w", err)
	}
	defer attributes.Delete()

	if err := attachPseudoConsole(attributes, pseudoConsole); err != nil {
		windows.ClosePseudoConsole(pseudoConsole)
		inputRead.Close()
		inputWrite.Close()
		outputRead.Close()
		outputWrite.Close()
		return nil, fmt.Errorf("attach terminal process attributes: %w", err)
	}

	shell := os.Getenv("ComSpec")
	if shell == "" {
		shell = filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	}
	if shell == "" {
		shell = "cmd.exe"
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine([]string{shell, "/D", "/Q"}))
	if err != nil {
		windows.ClosePseudoConsole(pseudoConsole)
		inputRead.Close()
		inputWrite.Close()
		outputRead.Close()
		outputWrite.Close()
		return nil, fmt.Errorf("prepare terminal command line: %w", err)
	}
	workingDirectory, err := windows.UTF16PtrFromString(workspace)
	if err != nil {
		windows.ClosePseudoConsole(pseudoConsole)
		inputRead.Close()
		inputWrite.Close()
		outputRead.Close()
		outputWrite.Close()
		return nil, fmt.Errorf("prepare terminal workspace: %w", err)
	}

	startup := windows.StartupInfoEx{
		StartupInfo:             windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})), Flags: windows.STARTF_USESTDHANDLES},
		ProcThreadAttributeList: attributes.List(),
	}
	process := new(windows.ProcessInformation)
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(nil, commandLine, nil, nil, false, flags, nil, workingDirectory, &startup.StartupInfo, process); err != nil {
		windows.ClosePseudoConsole(pseudoConsole)
		inputRead.Close()
		inputWrite.Close()
		outputRead.Close()
		outputWrite.Close()
		return nil, fmt.Errorf("start cmd.exe terminal: %w", err)
	}

	windows.CloseHandle(process.Thread)
	inputRead.Close()
	outputWrite.Close()
	return &terminalSession{id: id, console: pseudoConsole, process: process.Process, input: inputWrite, output: outputRead}, nil
}

// ConPTY requires synchronous pipe handles. os.Pipe uses non-blocking handles
// on Windows, so it cannot be used for either side of a pseudoconsole channel.
func newSynchronousPipe(name string) (*os.File, *os.File, error) {
	var readHandle, writeHandle windows.Handle
	if err := windows.CreatePipe(&readHandle, &writeHandle, nil, 0); err != nil {
		return nil, nil, err
	}

	readFile := os.NewFile(uintptr(readHandle), name+"-read")
	writeFile := os.NewFile(uintptr(writeHandle), name+"-write")
	if readFile == nil || writeFile == nil {
		if readFile != nil {
			readFile.Close()
		} else {
			windows.CloseHandle(readHandle)
		}
		if writeFile != nil {
			writeFile.Close()
		} else {
			windows.CloseHandle(writeHandle)
		}
		return nil, nil, errors.New("wrap terminal pipe handles")
	}
	return readFile, writeFile, nil
}

// PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE expects the HPCON handle value itself,
// not an address to that value. The generic x/sys helper accepts pointers to
// Go-managed values, so this Win32 call keeps the handle contract explicit.
func attachPseudoConsole(attributes *windows.ProcThreadAttributeListContainer, pseudoConsole windows.Handle) error {
	result, _, callErr := updateProcThreadAttribute.Call(
		uintptr(unsafe.Pointer(attributes.List())),
		0,
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		uintptr(pseudoConsole),
		unsafe.Sizeof(pseudoConsole),
		0,
		0,
	)
	if result == 0 {
		return fmt.Errorf("update pseudoconsole process attribute: %v", callErr)
	}
	return nil
}

func (s *terminalSession) start(emitOutput func(string), onExit func(int)) {
	go func() {
		buffer := make([]byte, 8192)
		for {
			count, err := s.output.Read(buffer)
			if count > 0 {
				emitOutput(string(buffer[:count]))
			}
			if err != nil {
				if !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed) {
					emitOutput(fmt.Sprintf("\r\nTerminal output error: %v\r\n", err))
				}
				return
			}
		}
	}()

	go func() {
		_, _ = windows.WaitForSingleObject(s.process, windows.INFINITE)
		var exitCode uint32
		_ = windows.GetExitCodeProcess(s.process, &exitCode)
		_ = windows.CloseHandle(s.process)
		onExit(int(exitCode))
	}()
}

func (s *terminalSession) write(data string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := io.WriteString(s.input, data); err != nil {
		return fmt.Errorf("write terminal input: %w", err)
	}
	return nil
}

func (s *terminalSession) resize(columns, rows int) error {
	coordinate := windows.Coord{X: int16(columns), Y: int16(rows)}
	if err := windows.ResizePseudoConsole(s.console, coordinate); err != nil {
		return fmt.Errorf("resize terminal: %w", err)
	}
	return nil
}

func (s *terminalSession) close() {
	s.closeOnce.Do(func() {
		_ = s.input.Close()
		_ = s.output.Close()
		go windows.ClosePseudoConsole(s.console)
	})
}
