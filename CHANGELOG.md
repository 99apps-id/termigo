# Changelog

All notable changes to Termigo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.9.12 - 2026-09-11

### Security

- **Go CLI / MCP server hardening (9 audit findings addressed)**
  - **F-01 CRITICAL**: `EvalCommand` in benchmark dataset now requires an
    allow-listed base command (`grep`, `wc`, `diff`, `find`, `sed`, `awk`,
    `jq`, `cat`, `ls`, `echo`, `python3`, `node`, `go`, etc.) and rejects
    shell metacharacters before execution. Previously any command in a JSONL
    dataset was executed verbatim via `sh -c` / `cmd /c`.
  - **F-05 MEDIUM**: `LoadDataset` and `Run` enforce workspace containment,
    preventing path-traversal datasets such as `--dataset /etc/shadow`.
  - **F-02 HIGH**: `validateShellCommand` in the Go MCP server now blocks
    `;`, `&&`, `||`, `|`, `$(...)`, backticks, and `${...}` in addition to
    the existing CR/LF, bidi-override, `rm -rf`, `dd`, `mkfs`, fork-bomb,
    and `curl|sh` checks.
  - **F-03 HIGH**: Windows control-plane liveness probe now uses a TCP
    reachability check to the descriptor address instead of signal-based
    `processAlive`, which always returned `true` on Windows and allowed stale
    descriptor token replay.
  - **F-04 HIGH**: `.termigo/mcp.json` `command` fields are validated against
    an allow-list of trusted executables (`npx`, `uvx`, `bunx`, `node`,
    `python3`, `go`, `bun`, `deno`, `npm`, `pnpm`, `yarn`, `java`, `ruby`,
    `rustc`, `cargo`) in both the Go CLI and the Tauri Rust backend,
    preventing supply-chain backdoors via project registries.
  - **F-06 MEDIUM**: Ollama endpoint validation now restricts HTTP to
    `localhost`, `127.0.0.1`, and `::1`; HTTPS is allowed for remote
    endpoints. Cross-host redirects are blocked.
  - **F-07 MEDIUM**: Preview address bar `probeUrl` now validates protocol
    (`http:`/`https:` only) and blocks private/internal IPv4 ranges
    (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`) and IPv6
    loopback/link-local/unique-local addresses over HTTP.
  - **F-08 LOW**: Documented the intentionally `unsafe` macOS Objective-C
    block that disables press-and-hold in `main.rs`.

## [Unreleased] - 0.9.11

### Added

- **Telegram relay - major UX overhaul**
  - Hermes-style progress output: compact one-line step summaries with tool
    call counts, elapsed time, and todo checklist; past tasks auto-hidden to
    keep the chat clean.
  - `/continue` command and inline button so the agent can resume past the
    step-cap without leaving the phone.
  - `/approve`, `Allow session`, and `Allow always` inline approval buttons -
    the approval request is now never silent: the bot always posts the pending
    action and waits for a tap rather than hanging invisibly.
  - `/model` shows an interactive provider + model picker including custom
    endpoints (e.g. StepFun, Qwen/DashScope) by friendly name.
  - Live typing indicator runs concurrently with agent dispatch so the chat
    never appears frozen during long steps.
  - Agent-pause notifications surface immediately when the agent stops between
    step-cap rounds.
  - Rich Markdown-to-Telegram formatting: tables converted to monospace
    preformatted blocks, fenced code blocks, bold headings.
  - `/pair` and `/unpair` commands; owner ID from secrets enables auto-enable
    in headless environments without an interactive GUI.
  - All progress labels, callbacks, and status messages translated to English.

- **Custom/compat model endpoints as default model**
  - `Preferences.defaultModelId` now accepts `compat-*` IDs (custom OpenAI-
    compatible endpoints such as StepFun or Qwen/DashScope) - previously any
    compat model saved as the default was silently reverted to the built-in
    default on next launch.
  - `getModel()` no longer throws on unknown IDs - returns a safe fallback
    instead of crashing React hydration and taking down the Telegram bot.
  - `useAiBootstrap` validates the stored default model ID on launch and falls
    back gracefully when the stored value references a deleted or renamed
    endpoint.
  - `/model` command in the Telegram bot resolves raw endpoint names and model
    IDs (e.g. `step-3.7-flash`) to the correct compat ID before persisting.
  - The Default Model picker in Settings now shows custom endpoints in a
    dedicated option group.

- **Headless / VPS deployment**
  - `scripts/deploy-termigo.sh`: safe deploy with automatic smoke-test
    (memory threshold + Telegram connection check) and rollback on failure.
  - `scripts/termigo-watchdog.sh`: systemd-friendly watchdog that restarts
    the service if the Telegram connection drops.
  - `scripts/run-headless.sh`: Xvfb + dbus-run-session launcher with WebKit
    compositing and DMA-BUF renderer disabled for GPU-less servers.
  - Deploy guard: `deploy-termigo.sh` refuses to interrupt a running agent
    unless `--force` is passed.
  - `termigo.service` systemd unit template included in `scripts/`.
  - `docs/headless-vps.md`: full VPS deployment guide updated to use
    `pnpm tauri build --no-bundle` (raw `cargo build` skips frontend bundling
    and produces a non-functional binary).

- **AI agent**
  - Vision-capable model routing: sub-agents that need to read images are
    automatically dispatched to a vision-capable model.
  - Autonomous continuous execution: agent runs multiple rounds without
    manual `/continue` when in auto-approve mode.
  - Instant context-overflow recovery.

- **Security**
  - Rust IPC boundary enforces a deny-list for secret paths: any `read_file`,
    `write_file`, or `stat` call targeting `secrets.json` or the OS keychain
    paths is rejected at the IPC layer before reaching the filesystem.

### Fixed

- **Telegram**
  - `resolveModelLabel` now resolves compat endpoint IDs to human-readable
    labels using the correct async import path.
  - Approval hang: bot now extracts pending approvals directly from the active
    chat message queue, so the agent never hangs silently awaiting a tap.
  - "Action Approved via Telegram" banner removed from the Termigo chat after
    an approval is granted via bot.
  - Live progress kept visibly alive during long steps with continuous
    message-edit pings.
  - Continue button used ASCII `->` instead of an emoji (fixes rendering on
    some Telegram clients).

- **AI model / compat**
  - `loadPreferences()` no longer silently reverts a compat model ID to the
    built-in default - fixes Telegram bot going silent after a restart when
    `defaultModelId` is a custom endpoint.
  - React hydration no longer crashes when `defaultModelId` references an
    endpoint that was renamed or deleted.

- **Build / deploy**
  - `deploy-termigo.sh --build` now calls `pnpm tauri build --no-bundle`
    instead of `npx tauri build`, ensuring `beforeBuildCommand` (frontend
    bundle) runs correctly.
  - `docs/headless-vps.md` corrected: replace `cargo build --release` with
    `pnpm tauri build --no-bundle` to produce a working binary.
  - `scripts/run-headless.sh` always picks the freshest termigo binary on
    restart.

- **AI agent**
  - Subagent input schema normalisation and todo payload repair.
  - Budget auto-continue hardened; trajectory ghost approval cards reconciled.
  - Collapsed-turn bloat trimmed: stale tail results elided and duplicate
    reads within one message deduplicated.
  - `git commit` execution made robust with line-ending reconciliation and
    idempotent `mkdir`.

## [0.9.10] - 2026-09-07

### Added

- **Failure-driven memory learning**
  - Memory sweep transcript extraction captures non-zero command exit codes, stderr outputs, and tool errors so mistakes and build traps are learned automatically as `[GOTCHA]` entries.
- **Global memory layer**
  - Cross-workspace memory support stored in `~/.termigo/memory.md` alongside project `.termigo/memory.md`.
  - Tool `remember` and functions `rememberFact`/`forgetFact` accept `scope: "project" | "global"`.
- **FTS code index persistence**
  - Okapi BM25 codebase index is cached to disk at `.termigo/code-index.json` for warm-startup retrieval.
  - Tool `code_index` forces fresh re-indexing on demand.
- **Relevance-scored memory injection**
  - General memory entries are ranked and filtered by query keyword overlap to protect system prompt headroom.
  - All `[GOTCHA]` and safety constraint entries are unconditionally preserved.

### Fixed

- **Approval watchdog timer leak**
  - Clear the 90-second post-approval watchdog timer on stream completion (`onFinish`), user cancellation (`onAbort`), and abort controller events, eliminating spurious timeout warnings and background abort signals.

## [0.9.9] - 2026-09-06

### Added

- **RAG codebase search and grounding**
  - BM25-ranked hybrid retrieval for repository symbols and files.
  - Strict grounding anti-hallucination enforcement before code mutations.
- **Agent autonomy enhancements**
  - Loop circuit breaker and automatic command output truncation.
  - Expanded filesystem inspection and autonomous harness profile controls.
- **WSL and pentest pipeline integration**
  - WSL path translation across pentest tools and pipeline context piping.
  - Guardrail policies configuration interface.

### Fixed

- **File encoding and compatibility**
  - Read non-UTF-8 (Windows-1252) and UTF-16 BOM text files cleanly without panics.
- **Agent trajectory and updater noise**
  - Eliminate false positive error reporting on trajectories and quiet noisy updater logs.
  - Stream watchdog logging for prolonged model executions.
  - Use explorer and launch cwd for workspace root resolution.
- **CI and cross-platform build**
  - Gate macOS launch imports in Rust backend to keep Linux and Windows builds warning-free.
  - Configure pnpm 11 workspace dependencies and driver scripts for e2e runner.
  - Synchronize pnpm-lock.yaml dependency overrides for pnpm 11 frozen-lockfile verification.

## [0.9.8] - 2026-09-05

### Added

- **Agent reliability and recovery**
  - Context-window auto-recovery: when a request outgrows the model's real
    context window, Termigo learns the actual cap from the provider's own
    overflow error, compacts the transcript harder and resumes the *same run*
    automatically instead of stopping mid-task.
  - Transient-provider-error recovery: a dropped internet connection pauses the
    run and resumes it automatically when back online; quota/credit exhaustion
    and rate limits preserve the run for a manual Try again.
  - Interrupted-run recovery: a run cut off by a restart is persisted and the
    session reopens with a **Resume** row (budget ladder kept).
  - Forced tool-choice recovery: some custom OpenAI-compatible endpoints run a
    "thinking mode" that rejects a pinned tool call with HTTP 400. Termigo now
    recognises the rejection, drops the pin for that model and resumes the
    request automatically — broad "audit/analyse this repo" prompts no longer
    die on a red card.
  - Mid-stream stall fix: long, bursty generations (e.g. a pentest report from
    a thinking-mode model) that legitimately pause over 30 s between chunks no
    longer get killed as "stalled"; the transport's idle bound is now 120 s and
    a real stall routes to the transient auto-retry instead of a dead error
    card.
  - Stop reliably halts a looping agent (internal + external loop levels), with
    no-progress and tool-error guards ending retry loops; run diagnostics now
    name exactly which guard stopped the run.
  - Context pruning: a verified span of history (work saved to git by a
    checkpoint/commit) is collapsed into a short checkpoint summary each turn,
    so finished work stops costing tokens.
  - Edit/multi_edit survive a model that drops or renames the `path` argument —
    the call self-corrects instead of hard-failing.
  - ask_user no longer loops when the model sends long options; .env.example
    templates are readable again; stuck "RUNNING" tool cards are closed as
    failed instead of hanging forever.
  - Plain-language status and error copy ("the model is taking a while to
    respond…" instead of internal terms like "provider"/"pin").

- **New agent tools**
  - `bash_wait` — block on a background process until it exits (the tool the
    model kept reaching for), completing the spawn trio with `bash_background`
    / `bash_logs` / `bash_kill`.
  - `dev_server` — detect the project's dev command, spawn it in the
    background, read its log for the real URL, health-probe the loopback port
    and open it in the browser pane.
  - `web_search` (DuckDuckGo-backed, no API key), `git_blame`, `git_show`,
    `read_pdf`, `read_image`, `clipboard_get` / `clipboard_set`, `env_get` /
    `env_list`.
  - `git_blame` / `git_show` for inspecting history at any commit.
  - In-chat elicitation (`ask_user`), opt-in post-execution Keep / Revert
    confirmation, and an **Artifacts** panel for canvases/previews/files the
    agent produced.
  - `list_sql_connections` - discover saved database connection profiles (PostgreSQL, MySQL/MariaDB, SQLite) from the workspace store.
  - `run_sql` connection resolution - execute queries against saved databases by name (e.g. `local_postgres` or `app_db`) without manually typing raw connection strings, with approval gating under `EXEC_TOOLS`.
  - MCP tool deserialization resilience - gracefully handle MCP tools with nullable descriptions (`description: null`) instead of failing tool registration.
  - MCP client JSON-RPC ID flexibility - accept both string and integer request/response IDs from MCP stdio servers.
  - MCP cache invalidation - automatically invalidate and reload registered MCP tools when adding or removing servers in Settings.
  - SQL Explorer query cards - custom syntax-highlighted SQL blocks and status chips in the AI tool chat feed.

- **Agent UX (BatikCode parity)**
  - Live run-progress HUD: current step, loop round, live todo list with a
    derived active item, and sub-agents running in a fan-out.
  - Sub-agent nesting depth (1–5) with a cost-tier guard; sub-agent runs
    persisted; parallel fan-out with `depends_on` chaining.
  - Centralised agent registry/factory; project-scoped approval rules
    (`.termigo/approvals.json`) now apply to sub-agents too.
  - Auto-verify after edits (read → change → verify → repair loop).
  - Fresh "New chat" on every launch; searchable, persisted session history.

- **Misc**
  - Extensible slash commands (`.termigo/commands/*.md`, `$ARGUMENTS`,
    `/` picker); `/schedule` recurring tasks; `/pipeline`.
  - Error boundary around the AI chat so a render error never blanks the panel;
    stable HUD selectors fix the AI-chat panel hang.
  - Mermaid diagrams render in the chat (no more blank canvas HTML).
  - Telegram relay polish: two-way mirror, Mermaid posted as pictures, report
    files (incl. PDF) uploaded, typing indicator, echo fix, `/model` picker.
  - Policy-engine fixes for orchestrator pipelines (halt on sequential step
    failure); git commands no longer climb into the user's home repo when
    outside a repository; `gh pr create` omits an empty `--base`.

### Changed

- `run_checks` guidance: pass a targeted command for small changes; `bash_run`
  default timeout raised so project builds/tests stop timing out and being
  re-run.
- ask_user options are normalised (capped, de-duplicated, clamped) before
  reaching the strict schema.

### Fixed

- Agent "hang" on large multi-step builds (concurrent-request race doubling the
  transcript, quadratic compaction, and request bodies over the provider's
  HTTP cap — compaction now also trims tool-call inputs and enforces a hard
  body ceiling).
- Content-moderation rejections are explained (and a new chat offered when the
  flagged text poisons history) instead of showing an opaque error.
- Windows drive paths repaired in tool-call JSON; `0.0.0.0` is never treated as
  a preview target (open `http://localhost:<port>` instead).
- Agent `extract`/`screenshot` work on the embedded browser pane; empty
  sub-agent completions surface instead of "(no output)".
- Terminal-home-dir git discovery guard, policy-engine evaluation, and lint
  cleanups (see commit history for details).
- Telegram bot relay prompt echo race condition: fixed an issue where user input typed in Telegram was mirrored back as an echo before the assistant reply stream. Implemented synchronous locking via `startTelegramDispatch`, module-scoped tracking (`seenMessageIds`, `seenFingerprints`), and prompt fingerprinting (`recordTelegramText`, `isTelegramOriginText`).
- SQL Explorer execution accuracy: fixed false-positive "Query OK" reporting by verifying command exit status codes (`output.status.success()`).
- SQL CLI binary normalization: mapped database engines to standard CLI binaries (`sqlite` to `sqlite3`, `postgres` to `psql`), added `--uri=` flag support for MySQL/MariaDB, and added Windows `CREATE_NO_WINDOW` execution flags.
- SQL output truncation inversion: shifted truncation to head-truncation to ensure table headers and leading rows remain readable when query outputs exceed size caps.
- Light theme contrast: improved contrast across file explorer trees, git status indicators, terminal pane borders, stack tabs, and shell input overlays.

## [0.9.5] - 2026-08-31

Last tagged public release. (Notable prior work: control-plane CLI
`termigo run/status/query`, pentest loop, MCP mirror, agent-driving loop,
replay + memory panel, api-client workbench, sandboxed extensions, context
meter.)

For the full commit history between releases, see
[GitHub](https://github.com/99apps-id/termigo/commits/main).
