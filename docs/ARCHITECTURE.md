# Architecture

```
Termigo
|
|-- Desktop application            Rust + Tauri 2 + React 19 + TypeScript
|   |-- src-tauri/src/main.rs      workspace, terminal, git, skills, agents
|   `-- src/                       React UI (TerminalPane, GitPane, SkillsPane,
|                                  AgentPane, CodeEditor, PreviewPane, explorer)
|
`-- termigo CLI                    Go
    |-- cmd/termigo                command dispatch (doctor, init, agent,
    |                              skill, mcp, config)
    `-- internal/
        |-- agent/                 provider registry + runner
        |-- config/                ~/.termigo/config.json
        |-- doctor/                local tool inspection
        |-- initcmd/               workspace scaffolding
        |-- mcp/                   MCP registry + JSON-RPC stdio client
        `-- skill/                 SKILL.md discovery and creation
```

## Boundaries

- **Local first.** Everything runs on the machine. No telemetry, no account.
- **Keys stay with their owners.** Provider credentials live in the provider's
  own CLI config or the OS keychain.
- **Workspace is the boundary.** File operations from the desktop are checked
  against the open workspace root.
- **Go is the automation layer.** The desktop shell surfaces what the CLI can
  already do headlessly.

## Desktop command surface (Tauri)

| Area | Commands |
| --- | --- |
| Workspace | `workspace_open`, `workspace_refresh`, `workspace_read_text_file`, `workspace_save_text_file`, `workspace_search_files` |
| Terminal | `terminal_start`, `terminal_write`, `terminal_read`, `terminal_close` |
| Git | `git_status`, `git_diff`, `git_stage`, `git_unstage`, `git_commit`, `git_log` |
| Skills | `skills_list` |
| Agents | `agent_status`, `agent_providers`, `agent_start`, `agent_read`, `agent_cancel` |

## Data layout

```
<workspace>/
├── .termigo/
│   ├── mcp.json            MCP server registry
│   └── skills/             project skills (SKILL.md per folder)
└── TERMIGO.md              project memory

~/.termigo/
├── config.json             providers, default agent, recent workspaces
├── mcp.json                user-level MCP servers
└── skills/                 user-level skills
```

## Verification

```powershell
Set-Location cli
go vet ./...
go test ./...

Set-Location ../desktop
npm run build               # tsc --noEmit && vite build
# Rust: cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```
