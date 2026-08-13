<div align="center">
  <img src="termigo.png" width="144" height="144" alt="Termigo" />
  <h1>Termigo</h1>

  <p><strong>Terminal-first, AI-native development workspace.</strong></p>
  <p>
    <a href="https://github.com/99apps-id/termigo">Repository</a>
    ·
    <a href="#features">Features</a>
    ·
    <a href="#getting-started">Getting started</a>
    ·
    <a href="#cli">CLI</a>
    ·
    <a href="#credits">Credits</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
    <img src="https://img.shields.io/github/license/99apps-id/termigo?color=blue" alt="license" />
    <img src="https://img.shields.io/badge/runtime-no%20Electron-brightgreen" alt="no Electron" />
    <img src="https://img.shields.io/badge/telemetry-none-blue" alt="no telemetry" />
  </p>
</div>

---

**Termigo** is a lightweight open-source, terminal-first AI-native development
environment (ADE) built on **Tauri 2 + Rust** with a **React 19** frontend. A
native PTY backend, an agentic AI side-panel that runs against your own keys or
fully local models, a code editor, file explorer, source control with a git
graph, and a web preview pane — all in one window. **No telemetry. No account.**
Your API keys stay in the OS keychain or with the provider's own CLI.

This project is a **fork of [Terax](https://github.com/crynta/terax-ai)**
(by Crynta, Apache-2.0), extended with a **Go command-line companion**
(`termigo`) for automation: agent runs, MCP, skills, and project scaffolding.

## Features

### Terminal

- Native PTY backend via `portable-pty` (pwsh, powershell, cmd, zsh, bash, fish)
- xterm.js with WebGL renderer, multi-tab with background streaming
- Split panels (horizontal and vertical)
- Inline search, link detection, true-color
- Drag files from the explorer into a terminal as shell-safe quoted paths
- Per-tab workspace environments on Windows (Local or WSL distro)
- Spaces restore tabs, working directories, and split layouts across launches

### SSH & remote files

- Connect to remote hosts with **ssh-agent**, private key, or password auth,
  directly as a terminal tab (ProxyJump chains supported)
- First-connect **host-key verification** (trust-on-first-use with fingerprint
  pinning) — the handshake pauses until you confirm
- **SFTP file explorer**: browse, create, rename, delete, upload (drag & drop)
  and download over the active SSH session
- Port forwarding (`-L`) through the session

### AI agent

- **BYOK providers:** OpenAI, Anthropic (Claude), Google (Gemini), Groq,
  xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral, plus any
  OpenAI-compatible endpoint
- **Sign in with your account (OAuth presets):** Codex (ChatGPT plan),
  Claude (Anthropic subscription), and Antigravity (Google Cloud Code) —
  one-click browser sign-in with PKCE, no API key needed; tokens live in
  your OS keychain and refresh automatically
- **Local / offline:** LM Studio, MLX, Ollama
- Agentic workflow: plans, sub-agents, project memory via `TERMIGO.md`,
  file read/write/edit/multi-edit/grep/glob, bash with approval gating,
  background processes
- Tool calls are **approval-gated**; approvals resume the run (including
  OpenAI-compatible providers such as DeepSeek)
- Coding-agent orchestration: spawn Claude Code in a terminal, inspect output,
  send follow-up work through approval-gated tools
- Composer: prompt snippets via `#handle`, files via `@path`, voice input
- Custom agents with their own system prompt and tool subset
- Plan mode for multi-step work, generates and confirms before doing

### Code editor

- CodeMirror 6 with support for TS/JS, Rust, Python, Go, C/C++, Java,
  HTML/CSS, JSON, Markdown and more
- Inline AI autocomplete with local model support
- AI edit diffs — accept or reject hunk by hunk
- Opt-in language server support (diagnostics, navigation, completion, formatting)
- Rendered Markdown plus image, video, audio, and PDF viewing
- Vim mode and built-in editor themes (Kanagawa, Catppuccin, Rosé Pine, Dracula, ...)

### Source control

- Stage / unstage hunks, commit (`Cmd+Enter` / `Ctrl+Enter`), push with
  upstream awareness
- Branch display including detached HEAD state
- Git history pane with a real commit graph (lane rendering for merges/branches)
- Commit search and filter, click through to the remote commit page

### Explorer & preview

- Catppuccin icon theme, fuzzy search, keyboard navigation, inline rename,
  live updates when files change on disk
- Attach files and selections directly to the AI side-panel
- Web preview auto-detects local dev servers; external URLs open in a child webview

### Themes & customization

- Custom themes built in-app, bundled presets, background images with
  adjustable opacity and blur
- Editor theme is independent from the app theme

## Getting started

### Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 22+ and [pnpm](https://pnpm.io)
- [Tauri platform prerequisites](https://tauri.app/start/prerequisites/)
  (Windows: MSVC Build Tools; Linux: webkit2gtk; macOS: Xcode CLT)

### Run from source

```bash
pnpm install
pnpm tauri:dev       # development
pnpm tauri build     # production bundle
```

Checks:

```bash
pnpm check-types     # tsc --noEmit
pnpm test            # vitest
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

### Windows notes

- Default shell detection: `pwsh.exe` (PowerShell 7+) → `powershell.exe` →
  `cmd.exe`
- WSL is a first-class workspace environment, not a wrapped subprocess

## CLI

The Go companion `termigo` automates what the desktop surfaces interactively:

```bash
cd cli
go run ./cmd/termigo help
go run ./cmd/termigo doctor --json        # inspect local tools
go run ./cmd/termigo init <dir>           # scaffold .termigo/ + TERMIGO.md
go run ./cmd/termigo agent list           # installed agent providers
go run ./cmd/termigo agent run codex "explain this repo" --access read-only
go run ./cmd/termigo skill create review "Review diffs before commit"
go run ./cmd/termigo mcp list             # configured MCP servers
go run ./cmd/termigo mcp tools fs         # list tools of an MCP server
```

- **Providers:** Codex, Claude Code, Gemini, Antigravity, Ollama (local)
- **Skills:** project- and user-scoped `SKILL.md` folders under
  `.termigo/skills/` and `~/.termigo/skills/`
- **MCP:** standard `mcpServers` registry in `.termigo/mcp.json`, JSON-RPC 2.0
  over stdio (initialize, tools/list, tools/call, ping)
- **Never stores API keys** — credentials stay with each provider's own CLI

See [`docs/`](docs/) for the MCP, skills, agents, and architecture guides.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/web-preview.png" alt="Web preview" /><br/><sub>Web preview of local dev servers</sub></td>
    <td align="center"><img src="docs/ai-workflow.png" alt="AI window" /><br/><sub>Agentic AI workflow with edit diffs in the code editor</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/themes.png" alt="Themes and background image" style="margin-top: 12px;"/><br/><sub>Custom themes, presets, and background images</sub></td>
    <td align="center"><img src="docs/source-control.png" alt="Source control and git graph" style="margin-top: 12px;"/><br/><sub>Source control panel with git graph in history</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/terminal.png" alt="Terminal" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>Block-based WebGL terminal with editor-like input panel</sub></td>
  </tr>
</table>

## Architecture

```text
Termigo
|-- Desktop application        Rust + Tauri 2 + React 19 + TypeScript
|   |-- src-tauri/             PTY, shell, git, agents, workspace, control
|   `-- src/                   React UI (terminal, editor, AI, git, explorer)
`-- termigo CLI                Go
    `-- cli/                   agent, mcp, skill, config, doctor, init
```

A Tauri 2 app: a React 19 webview talks to a Rust backend via `invoke()` and
streaming `Channel`s. The Go CLI is the automation layer — anything useful
headlessly lives in `cli/internal/` first.

## Privacy and safety

- **Local first.** Folders, commands, keys, and project context stay on the
  machine. No telemetry, no account.
- **Keys stay with their owners.** Provider credentials live in the provider's
  own CLI config or the OS keychain.
- **Approval gates.** Agent file changes and commands require review/approval;
  the workspace is the boundary for file operations.
- **MCP is explicit.** Servers only run when you configure and connect to them.

## Credits

Termigo is a **fork of [Terax](https://github.com/crynta/terax-ai)** by
[Crynta](https://github.com/crynta) (Apache-2.0). The Tauri/Rust backend, the
xterm.js terminal, the CodeMirror editor, and the AI agent pipeline are the
work of Crynta and the Terax contributors. If Termigo is useful, please star
upstream [Terax](https://github.com/crynta/terax-ai).

The design also draws inspiration from
[TEDI](https://github.com/IlhamriSKY/TEDI) (a Terax fork by Ilham Riski
Wibowo) for its "one window, many tools" direction. No TEDI source code is
included in this repository.

## License

[Apache-2.0](LICENSE), the same license as the upstream Terax project.
