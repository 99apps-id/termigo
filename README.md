# Termigo

<p align="center">
  <img src="./termigo.png" alt="Termigo" width="640">
</p>

<p align="center">
  <strong>A lightweight, terminal-first workspace for AI-assisted development.</strong>
</p>

Termigo is a focused desktop workspace for developers who want the daily loop in
one small window: terminals, files, code editing, local preview, coding agents,
and a practical command-line companion. It is deliberately not a full IDE.

Maintained by [99apps-id](https://github.com/99apps-id).

> **Status: desktop alpha.** A Rust/Tauri desktop foundation is now available
> under `desktop/`: it opens a workspace with the native folder picker, shows a
> safe file tree, edits text files inside that selected workspace, and connects
> its Agent panel to a locally installed Codex CLI.
> The earlier Go/Wails application remains as a legacy prototype while the new
> desktop surfaces are migrated progressively.

## Product direction

Termigo is for developers who prefer a terminal-first workflow without giving
up the few visual tools that genuinely save time.

- **Terminal first** - persistent shell sessions, tabs, splits, and project-aware working directories.
- **Small by design** - native OS webview and a target installer size below 20 MB.
- **Local first** - folders, commands, keys, and project context stay on the machine.
- **Agent ready** - use installed coding CLIs now; add managed providers, BYOK, local models, skills, and MCP progressively.
- **Not an IDE clone** - no extension marketplace, debugger suite, or broad language-server platform as the core product.

## Planned experience

| Surface | Purpose |
| --- | --- |
| **Terminal** | Multiple persistent shells, tabs, splits, search, and background output. |
| **Workspace** | Open folders, a fast file tree, recent projects, and restored sessions. |
| **Editor** | A compact code editor for reading, changing, and reviewing files near the terminal. |
| **Preview** | An in-app browser for local development servers. |
| **Agent** | A dedicated chat/composer that can invoke approved local tools and present edits for review. |
| **Provider hub** | OAuth, API-key, local-model, and existing-CLI connections without forcing a single vendor. |
| **Git** | Focused changed-files, diff, branch, commit, and history workflows. |
| **Skills and MCP** | Project-scoped skills and explicit, permission-aware MCP integrations. |

## Architecture

```text
Termigo
|
|-- Desktop application
|   |-- Rust + Tauri 2       native window, PTY, secure OS integrations
|   `-- React + TypeScript   terminal, editor, explorer, preview, agent UI
|
`-- termigo CLI
    `-- Go                  automation, local agent helpers, project commands
```

Rust/Tauri is chosen for the desktop application because it provides a compact
native shell and mature terminal/desktop primitives. Go remains a first-class
part of Termigo, but belongs in the CLI and automation layer rather than being
forced to reproduce the entire desktop surface.

## CLI

The Go CLI is the automation and agent companion: `termigo doctor` checks local
tools, `termigo init` scaffolds a workspace, `termigo agent` drives installed
coding agents, and `termigo mcp` and `termigo skill` manage the integration
surface. It never stores API keys.

```powershell
Set-Location cli
go run ./cmd/termigo help
go run ./cmd/termigo doctor --json
go run ./cmd/termigo init <project-dir>
go run ./cmd/termigo agent list
go run ./cmd/termigo agent run codex "Explain this repo" --access read-only
go run ./cmd/termigo skill create review "Review diffs before commit"
go run ./cmd/termigo mcp add fs npx -y @modelcontextprotocol/server-filesystem .
go run ./cmd/termigo mcp tools fs
go build -trimpath -ldflags '-s -w' -o .\bin\termigo.exe .\cmd\termigo
```

Provider support: **Codex**, **Claude Code**, **Gemini**, **Antigravity**, and
**Ollama** (local). Skills live in `.termigo/skills/<name>/SKILL.md`; MCP
servers are declared in `.termigo/mcp.json` using the standard MCP shape.
User-level skills and servers can be stored under `~/.termigo/`.

## MCP and skills

- **MCP (Model Context Protocol)** - Termigo reads the standard `mcpServers`
  registry from `<workspace>/.termigo/mcp.json` (plus `~/.termigo/mcp.json`)
  and talks JSON-RPC 2.0 over stdio to each server: initialize, list tools,
  call tools, ping. See [`docs/MCP.md`](docs/MCP.md).
- **Skills** - project- and user-scoped instruction folders with a `SKILL.md`
  (YAML frontmatter + Markdown). Agents receive the descriptions so they can
  follow project conventions. See [`docs/SKILLS.md`](docs/SKILLS.md).
- **Project memory** - `TERMIGO.md` at the workspace root records conventions,
  build commands, and workspace notes for agents. `termigo init` scaffolds it.

## Desktop alpha

The new desktop application is intentionally small at this stage: native
window controls, **Open folder**, an expandable explorer, tabs, a Monaco-based
code editor with syntax highlighting and `Ctrl+O` / `Ctrl+S`, a workspace-local
Command Prompt panel, and a Codex Agent chat. File access is checked again by
the Rust backend, so an open workspace is the boundary for reading and saving
files.

The **Agent** tab uses the locally installed `codex` CLI and its existing
ChatGPT sign-in. No OpenAI API key is needed for this path, and Termigo does not
receive or store the OAuth credential. Each task is sent to the CLI through
stdin and uses an ephemeral session rooted at the active workspace. The default
**Inspect only** mode is read-only; choosing **Edit active workspace** requires
a confirmation immediately before a task starts.

The **Preview** tab is intentionally local-only: it accepts `localhost` and
`127.0.0.1` HTTP(S) development servers, not arbitrary web URLs. Start the
server from the terminal (for example `npm run dev`) and open the reported URL.

```powershell
Set-Location desktop
npm install
npm run tauri dev

# Build the Windows application
npm run tauri build
```

The terminal is a reliable pipe-based shell for everyday command-line tools
such as Git, npm, Go, Cargo, and coding CLIs. It is not yet a full PTY, so
terminal UI applications, advanced line editing, and `Ctrl+C` behavior are
limited. A multi-provider hub, durable agent task history, reviewable diffs,
and additional OAuth/BYOK connections remain the next migration steps.

## Desktop features (current)

- **Terminal** - multi-tab sessions with background streaming, inline search
  (`Ctrl+F`), new tab (`Ctrl+T`), and PowerShell-first shell detection
  (PowerShell 7 -> Windows PowerShell -> Command Prompt).
- **Source control** - branch, status list (staged/unstaged), per-file diff,
  stage/unstage, commit, and a recent history view.
- **Skills** - the Skills tab lists project and user skills found on disk.
- **Agent** - Codex chat with read-only/workspace-write access modes, plus
  detection of every installed agent provider (Codex, Claude Code, Gemini,
  Ollama).
- **Explorer** - file tree plus live file-name search across the workspace.
- **Editor / Preview** - Monaco-based editing with syntax highlighting and
  local-only web preview as before.

## Roadmap

1. **Re-baseline** - establish the Rust/Tauri desktop shell, branding, updater strategy, size budget, and Windows build pipeline.
2. **Daily workspace** - durable workspace sessions, multi-tab/split terminals, explorer, editor, preview, and Git basics. *(multi-tab terminal, file search, and Git panel landed; splits and durable sessions remain)*
3. **Agent workflow** - provider hub, model selection, BYOK/OAuth, local models, approvals, diffs, and task history. *(provider detection and multi-provider CLI landed; in-app provider execution, approvals, and task history remain)*
4. **Extensibility** - project skills, MCP, and the Go `termigo` CLI. *(skills framework, MCP client/registry, and the expanded CLI landed)*
5. **Polish** - startup, accessibility, settings, recovery, installers, and cross-platform support.

## Current prototype

The existing Go/Wails experiment can open a folder, edit text files, run a
Windows terminal, display a local preview, and detect installed CLIs. It is a
temporary proof of direction, not the intended long-term desktop architecture.

For maintenance of the current prototype:

```powershell
go vet ./...
go test ./...
Set-Location frontend
npm run build
```

## Privacy and safety

- Local project files must remain within the selected workspace boundary.
- Secrets should be stored only in the operating-system keychain or entered by
  the user; Termigo must never commit or log them.
- Agent file changes and commands require clear review and approval controls.
- Telemetry is opt-in. The default product direction is private and local-first.

## Upstream and attribution

Termigo takes product inspiration from the terminal-first workspace category.
No TEDI source code is currently included in this repository. If a future
Termigo component is forked from Apache-2.0 upstream code, its license, notices,
copyright statements, and required attribution will be preserved in that change.

## Contributing

The Rust/Tauri migration is the priority. Please keep proposals small, focused,
and aligned with the terminal-first and local-first principles. Do not add broad
IDE features without a clear user workflow and a size/performance justification.

## License

License selection is pending. Until a license is added, do not assume this
repository may be redistributed.
