# Termigo

Termigo is a small, local-first AI workspace for Windows. It is built from
scratch with Go and Wails rather than carrying a large editor engine.
The product goal is an installer below 20 MB while keeping the daily workflow
in one window: folders, editing, commands, local preview, and coding-agent
connections.

## Current foundation

- Open a local folder and browse a capped, dependency-aware file tree.
- Read and save text files inside the active workspace with path traversal
  protection.
- Edit supported files in Monaco.
- Run visible, user-triggered `cmd.exe` commands in the active workspace.
- Preview a local web address in the application.
- Detect installed Codex, Gemini, Antigravity, Ollama, Git, Go, Node.js, and
  Python CLIs without reading their credentials.
- Build a stripped Windows executable with WebView2 supplied by the operating
  system. The first baseline binary is 11.29 MB.

The command panel is intentionally a command runner in this milestone. A fully
interactive ConPTY session, agent approval policy, provider accounts/OAuth,
skills, and MCP are the next layers.

## Privacy and safety

- This milestone does not use an OpenAI API key or any cloud provider key.
- CLI detection only checks command availability and version output.
- Workspace file reads and writes reject paths outside the folder selected by
  the user.
- Commands run only when entered by the user in the terminal panel. Agent
  command execution will be approval-gated before it is introduced.

## Development

Prerequisites: Go, Node.js, WebView2, and Wails v2.

```powershell
wails dev
```

Run checks:

```powershell
go vet ./...
go test ./...
Set-Location frontend
npm run build
```

Build the compact production executable:

```powershell
wails build -clean -trimpath -ldflags '-s -w'
```

The executable is written to `build/bin/termigo.exe`.

## Architecture

- `app.go`: Go services for workspace files, command execution, and local CLI
  discovery.
- `frontend/`: React interface, Monaco editor, and terminal surface.
- `main.go`: Wails desktop entry point.

## Roadmap

1. Replace the command runner with a true ConPTY terminal and persistent
   workspace sessions.
2. Add CLI-backed agent sessions and approval-gated file/command tools.
3. Add provider accounts, OAuth, model selection, skills, and MCP.
4. Add Git changes and a production installer, then enforce the 20 MB budget
   in release checks.
