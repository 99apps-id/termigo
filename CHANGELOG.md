# Changelog

All notable changes to Termigo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The last tagged public release before this cycle was **v0.9.5**; v0.9.6 and
v0.9.7 were built and validated locally but never tagged. **v0.9.8** therefore
carries everything shipped since v0.9.5.

## [0.9.8] - 2026-09-03

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

## [0.9.5] - 2026-08-31

Last tagged public release. (Notable prior work: control-plane CLI
`termigo run/status/query`, pentest loop, MCP mirror, agent-driving loop,
replay + memory panel, api-client workbench, sandboxed extensions, context
meter.)

For the full commit history between releases, see
[GitHub](https://github.com/99apps-id/termigo/commits/main).
