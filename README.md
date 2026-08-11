# Termigo

**A lightweight, terminal-first workspace for local AI-assisted development on Windows.**

Termigo keeps the daily coding loop in one compact native window: open a folder,
edit files, run commands, preview local apps, and connect the coding tools already
installed on your machine. It is built from scratch with Go and Wails—no bundled
browser runtime and no heavyweight editor engine.

> **Status: early foundation.** The workspace is usable today; persistent
> terminals, AI sessions, accounts, and integrations are being built next.

## Why Termigo?

Most development environments are either a terminal with too little context or a
large editor with far more machinery than a focused coding session needs. Termigo
aims for a middle ground: a fast, local-first workspace with just the essential
surfaces and a clear route to capable coding agents.

- **Local-first:** folders and commands stay on the machine you selected.
- **Compact:** the first stripped Windows binary is **11.29 MB**; the project
  target is an installer below 20 MB.
- **Bring your own tools:** detects installed coding CLIs without reading their
  credentials.
- **Security by design:** workspace path checks prevent reads and writes outside
  the folder you opened; future agent actions will require explicit approval.

## Available today

| Surface | What it does |
| --- | --- |
| **Workspace explorer** | Open a local folder and browse a capped, dependency-aware file tree. |
| **Code editor** | Read, edit, and save supported text files using Monaco. |
| **Command panel** | Run a visible, user-entered `cmd.exe` command in the active workspace. |
| **Web preview** | Open a local development URL inside the application. |
| **CLI discovery** | Detect Codex, Gemini, Antigravity, Ollama, Git, Go, Node.js, and Python by executable and version only. |
| **Native Windows build** | Build a stripped executable using the system WebView2 runtime. |

## What is next?

| Area | Direction |
| --- | --- |
| **Terminal** | Persistent interactive ConPTY sessions, shell selection, and workspace restoration. |
| **AI agents** | CLI-backed sessions with approval-gated file and command tools. |
| **Models** | Provider accounts, OAuth, model selection, and local-model connections. |
| **Extensibility** | Project skills and MCP integrations. |
| **Developer workflow** | Git changes, commits, a production installer, and an enforced size budget. |

## Privacy and safety

- This foundation does not require or transmit an OpenAI API key or any cloud
  provider key.
- CLI discovery checks executable availability and version output; it does not
  read tokens, API keys, or account data.
- File operations reject paths outside the selected workspace.
- Commands execute only after the user enters them in the command panel. AI
  command execution will not be introduced without an approval gate.

## Getting started

### Prerequisites

- Windows 10 or later with [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
- [Go](https://go.dev/) 1.26 or later
- [Node.js](https://nodejs.org/) 24 or later
- [Wails v2](https://wails.io/)

### Run from source

```powershell
git clone https://github.com/99apps-id/termigo.git
Set-Location termigo
wails dev
```

### Verify

```powershell
go vet ./...
go test ./...
Set-Location frontend
npm run build
```

### Build a compact executable

```powershell
wails build -clean -trimpath -ldflags '-s -w'
```

The result is written to `build/bin/termigo.exe`.

## Architecture

```text
Termigo
├── Go + Wails       native window, workspace boundary, commands, CLI discovery
└── React + TypeScript
    ├── Explorer     local workspace tree
    ├── Monaco       code editing
    ├── xterm.js     command surface (interactive PTY planned)
    └── Preview      local web application view
```

## Project structure

```text
app.go          Go services for workspace files, commands, and CLI discovery
app_test.go     workspace-boundary and command tests
frontend/       React interface, Monaco editor, terminal, and preview surfaces
main.go         native desktop entry point
wails.json      Windows application configuration
```

## Contributing

Termigo is in its early stage. Bug reports, focused feature proposals, and small
pull requests are welcome. Before opening a pull request, please run the checks
in [Verify](#verify) and keep changes aligned with the local-first, small-binary
goal.

## License

License selection is pending. Do not assume this project may be redistributed
until a license is added.
