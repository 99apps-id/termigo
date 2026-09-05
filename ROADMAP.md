# Roadmap

Termigo direction, what's shipped, what's coming, and what's deliberately out of scope.

This file is updated as direction evolves. For day-to-day work, see [GitHub Issues](https://github.com/99apps-id/termigo/issues) and the Projects board.

## What Termigo is

Termigo is a fast, lightweight, terminal-first AI-native development environment (ADE). It pairs a native PTY backend with a modern UI: multi-tab terminals, an integrated code editor, a file explorer, source control, and a first-class AI agent system that works with your own API keys or fully local models. About 7-8 MB on disk. No telemetry. Keys stored in the OS keychain.

The product is opinionated: terminal-first, AI as a primitive (not a sidebar), lightweight always, cross-platform without compromise.

## What Termigo is not

- Not an IDE clone. Termigo selectively integrates high-value editor capabilities such as LSP, AI autocomplete, formatting, source control, and previews without adopting the heavyweight runtime and always-on background services of a traditional IDE.
- Not a browser. Web preview exists for local dev servers and lightweight doc viewing only.
- Not a general workspace. Tools and formats that pull the product away from the terminal-first surface are out of scope.
- Not a one-size-fits-all CLI replacement. The goal is the best terminal-first AI-native development environment, not a shell with extras.

## Themes

The themes below frame every scope decision.

1. **AI as a native primitive.** Agents, tools, autocomplete, voice - first-class, not a panel bolted onto a regular terminal.
2. **Lightweight always.** 7-8 MB binary. Every dependency justified. Per-tab memory budget enforced.
3. **Terminal-first.** xterm.js correctness, PTY fidelity, TUI app compatibility are non-negotiable.
4. **Cross-platform parity.** macOS, Linux, Windows, WSL. No platform-specific exclusives.
5. **Security by default.** Path guards, SSRF protection, OSC trust, IPC sandboxing. Defaults safe out of the box.

## Shipped

### Terminal

- [x] Multi-tab terminal with WebGL renderer
- [x] Native PTY backend (zsh, bash, pwsh, fish, cmd)
- [x] Split panes
- [x] Shell integration (cwd, prompt markers)
- [x] Inline search, link detection, true-color
- [x] Drag and drop files into terminal panes as shell-safe quoted paths
- [x] Private terminal tabs with AI-context redaction
- [x] WSL bridge as workspace environment
- [x] Spaces with restored tabs, working directories, and split-pane layouts

### Editor

- [x] Multi-language support (TypeScript / JavaScript, Rust, Python, HTML / CSS, JSON, Markdown, Go, C / C++ / Java / C#, PHP)
- [x] Inline AI autocomplete with automatic and manual triggering, multiline suggestions, and local-model support
- [x] AI edit diffs
- [x] Opt-in LSP support with diagnostics, navigation, completion, formatting, and custom servers
- [x] Vim mode

### Themes and Customization

- [x] Prebuilt and custom app and terminal themes with import and sharing
- [x] Background images with adjustable opacity and blur
- [x] App-theme-aware and independently selectable editor themes

### File Explorer

- [x] Icon theme with full file-type coverage
- [x] Fuzzy search, keyboard navigation, inline rename, context actions
- [x] Live filesystem updates in the explorer and open editor tabs

### Git / Source Control

- [x] Source control panel (stage, commit, branch)
- [x] Git history with commit graph
- [x] Per-file diffs

### AI

- [x] Multiple cloud and local providers (BYOK)
- [x] Multi-agent and sub-agents
- [x] Sub-agent orchestration: batched fan-out with concurrency limits, and `depends_on` chaining so a task receives what earlier tasks found
- [x] Approval-gated Claude Code orchestration with spawn, output inspection, and follow-up
- [x] Voice input
- [x] Reusable prompt snippets via `#handle`
- [x] Project memory and per-project configuration
- [x] Self-maintaining memory the agent writes and reads back, bounded in size
- [x] Reusable skills in `.termigo/skills/`, loaded on demand, discoverable across other agents' libraries
- [x] MCP servers, per-project and per-user, sharing one config with the Go companion
- [x] MCP protocol resilience: handles nullable tool descriptions, flexible string/int JSON-RPC IDs, and reactive cache invalidation upon configuration changes
- [x] SQL Explorer: native database connection management (SQLite, PostgreSQL, MySQL/MariaDB), schema inspection, and agent tools (`list_sql_connections`, `run_sql`) with strict approval gating
- [x] Telegram bot relay reliability: echo elimination with synchronous dispatch locking (`startTelegramDispatch`) and origin fingerprinting
- [x] Web search (`web_search`, DuckDuckGo-backed, SSRF-guarded, no API key)
- [x] Document and image tools: `read_pdf` (text extraction from compressed PDFs) and `read_image` (vision-capable image reading)
- [x] Clipboard and environment tools: `clipboard_get` / `clipboard_set` and `env_get` / `env_list`
- [x] Git history tools: `git_blame` and `git_show` (inspect any commit)
- [x] Artifacts panel — canvases, previews and files the agent produced, reopened in one click
- [x] Dev-server orchestration (`dev_server`) — detects the project's dev command
  (package.json scripts), spawns it in the background (deduping a running
  instance), reads the server's own log for the real URL (ported `findLocalUrl`
  from TEDI, ANSI-safe, `0.0.0.0` → `127.0.0.1`), health-probes the loopback
  port until it responds (Rust `http_probe`, loopback-only), then opens it in
  the browser pane. Watch/stop via `bash_logs`/`bash_kill`, block on a
  background build/install with `bash_wait`, and control the page via the
  `browser_*` tools.
- [x] In-chat elicitation (`ask_user`) — the agent pauses for a clickable choice
- [x] Opt-in post-execution confirmation (Keep / Revert after a mutating tool, with git-based revert)
- [x] Sub-agent nesting depth (1–5), cost-tier guard, and sub-agent runs persisted to disk
- [x] Extension-contributed AI tools
- [x] Agent-defined tools as shell templates in `.termigo/tools.json`
- [x] Tools with per-action approval gating (file write / edit, bash, and filesystem mutations)
- [x] Graduated auto-approval modes, with deletion never delegated in any mode
- [x] Step budgets that escalate per Continue, with named stop reasons
- [x] Per-run diagnostics line and an opt-in request inspector
- [x] Workspace file picker
- [x] Auto-compact for long context

### SSH and remote

- [x] SSH sessions with key and password auth, and `known_hosts` verification
- [x] SFTP-backed remote file browsing and editing
- [x] Port forwarding, so a service on the remote host is reachable locally
- [x] Agent file tools follow the session onto the remote host, with `grep` and `glob` running server-side
- [x] Remote commands gated by what they do rather than by being remote

### Previews

- [x] Auto-detected local dev server preview
- [x] Image, video, audio, and PDF viewers
- [x] Rendered Markdown preview with raw and rendered views
- [x] Sandboxed iframe

### Platform Integration

- [x] macOS, Linux (.deb / .rpm / AppImage), Windows (NSIS), WSL
- [x] AUR (Arch)
- [x] Windows Explorer context-menu integration
- [x] Auto-updater
- [x] OS keychain for API keys
- [x] No telemetry

### Security

- [x] Hardened AI tool surface (file system, network, IPC)
- [x] SSRF and DNS rebinding defenses on outbound HTTP
- [x] Trust gating in terminal escape-sequence handling
- [x] Sandboxed preview surface

### Engineering

- [x] Regression coverage across critical PTY, security, AI tool, editor, explorer, theme, and native-boundary behavior
- [x] Enforced startup and total client bundle budgets with heavy editor, AI, Markdown, and source-control surfaces loaded on demand

## Planned

### Coming next

- [ ] AI-powered inline terminal suggestions, opt-in (history-based suggestions have shipped)
- [x] AI agent reliability and workflow improvements — tool execution, context
  management, recovery, and long-running tasks. Shipped: context-window
  auto-recovery, transient-provider-error recovery, interrupted-run recovery
  after a restart, loop round-cap, no-progress / tool-error guards, the
  per-run workspace anchor, rotating thinking-phrase status (no step spam),
  context pruning — a verified span of history (saved to git via a
  checkpoint) is collapsed into a checkpoint summary each turn to save
  tokens — forced tool-choice recovery for thinking-mode endpoints (the pin
  is learned away and the request auto-resumes), a burst-tolerant mid-stream
  idle bound (120s) with stall routing to the transient auto-retry,
  dropped-path repair for edit/multi_edit, and plain-language status/error
  copy.
- [x] Expand external coding-agent orchestration beyond Claude Code — built-in
  launchers for Codex, Gemini, Pi, OpenCode, Grok, Aider, Qwen and Cursor, plus
  user-defined custom coding-agent CLIs in Settings.
- [x] Agent UX parity with BatikCode-style host agents — sub-agent nesting
  depth, cost-tier guard, persisted sub-agent runs, editable/resendable user
  messages, live background-command output, modified-file chips in tool
  cards, a centralized agent registry/factory (`buildSubagentSpec`,
  `buildAgentTools`, `resolveAgentForPrompt`), and a live run-progress HUD
  showing the current step, the todo list with a derived active item, and the
  sub-agents running in a fan-out.
- [x] Telegram relay polish - typing indicator while the agent works, an
  echo fix so messages the bot injects are never mirrored back, synchronous
  dispatch locking, and prompt fingerprinting.
- [x] Extensible slash commands — a fixed set ships (`/init`, `/plan`, `/goal`,
  `/model`, …), and user-authored commands live in `.termigo/commands/*.md`
  (frontmatter `description:` + a prompt body, `$ARGUMENTS` placeholder),
  listed by the `/` picker and re-scanned on open.
- [x] Project-scoped approval policies and per-tool trust — `.termigo/approvals.json`
  rules (per tool / path glob / command pattern) refine the global approval
  mode per project: `allow` auto-runs, `deny` auto-refuses, `ask` forces a
  prompt. Applied to the main agent and, since the latest pass, to sub-agents
  too, so a rule set for the agent holds for its workers. Managed from the
  approval-mode control and the per-approval "always allow in this project"
  affordance.
- [x] Persistent terminal processes across app restarts — Unix via a named tmux
  session per leaf; the setting is now surfaced honestly where tmux isn't
  available (Windows remains a guarded no-op, pending a detached PTY host).

### Longer horizon

- [ ] Selective TS → Rust migration where the profiler shows measurable wins
- [ ] AI tools / skills as installable bundles

## Wanted contributions

Strategic areas where help is welcome. Pick something and propose an approach in Discord or via an issue first.

- **Regression tests.** Add focused coverage for bug fixes and critical PTY, security, AI tool, and native-boundary invariants.
- **Measured performance work.** Profile first and propose focused changes that preserve startup time, bundle size, memory use, and hot-path latency.
- **Platform-specific bugs.** Rendering issues on niche distros, shell quirks, WSL edge cases.
- **Documentation and translations.** Improvements, screenshots, examples, non-English README sections.
- **Themes.** Terminal and editor themes, UI accent palettes that fit the lightweight aesthetic.
- **Provider integrations.** Only providers that add unique value beyond existing coverage. Justify the case before implementing.

See `good-first-issue` and `help-wanted` labels on GitHub Issues for concrete tasks.

## Out of scope

Categories that will not be built into Termigo. Individual feature requests in these categories will be closed.

- **Heavyweight IDE infrastructure.** Integrated debugger and profiler suites, unbounded background indexing, and always-resident extension hosts are out of scope. Focused LSP, autocomplete, formatting, and editor workflows remain in scope when they are opt-in, lazy, and resource-bounded.
- **Notebook and document workspaces.** Anything that turns Termigo into a document host rather than a terminal.
- **Package manager and toolchain UIs.** Use `npm`, `pip`, `cargo` and friends in the terminal directly.
- **Full web browser features.** Preview pane stays scoped to local dev servers and lightweight doc viewing. No navigation history, no bookmarks, no dev tools.
- **Telemetry, analytics, accounts.** Termigo stays BYOK and offline-respectful.
- **Extension marketplaces at IDE scale.** Narrowly-scoped AI tool / skill bundles may happen eventually. Arbitrary UI or behavior extensions will not.
- **Third-party subscription session bridges.** Forwarding cloud subscription auth (provider-managed login sessions) through Termigo is not technically feasible for third-party clients.

## Decision authority

Direction and scope decisions are made by [@99apps-id](https://github.com/99apps-id). Trusted reviewers (informal, no fixed roles yet) provide input on security, performance, and platform-specific areas.

If a PR is closed and you disagree, raise it in Discord. Happy to discuss, not happy to be ambushed in a PR comment thread.

This will likely formalize over time as the project grows.
