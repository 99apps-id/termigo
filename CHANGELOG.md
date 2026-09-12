# Changelog

All notable changes to Termigo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Mirrored replies arrived last and out of order.** The Termigo to Telegram
  mirror held every assistant message until the run settled
  (`if (m.role === "assistant" && !settled) continue;`). One assistant message
  accumulates ALL the steps of a run, the loop walks the transcript in order,
  and a newer user message was delivered at once - so the held reply landed
  after content that came later: "output chat ditumpuk di belakang". An
  assistant message is now sent once and then edited in place while its text
  grows, the way the other agent bots do it.
  - Sending immediately instead would have truncated every reply, which is why
    this needed a state machine rather than a one-line change: `messageText()`
    joins every text part so the text grows, while `markMessageSeen` keys on the
    message **id** and `isMessageSeen` returns true on the id alone. The first
    partial send marks it seen, and the completed answer can never arrive.
  - A quiet run is deliberately NOT treated as a finished one: provider latency
    on a real endpoint is 5-70s per step, so quiet text is the middle of a run,
    not its end. Only `idle`/`error` finalizes.
  - Also fixed on this path: an assistant message that was empty on its first
    tick was marked seen and lost (it exists from its first reasoning part), and
    a message over Telegram's 4096 limit now stops streaming and is delivered in
    full by the settle path instead of failing to send.
  - Still true, and unchanged: a Telegram-initiated run is handled by the relay
    (`dispatchAndStream`), which streams a live progress card and sends the
    answer when the run settles - the mirror is paused for it.
- **The Telegram relay now logs what it is doing.** It logged nothing at all:
  `grep -ci telegram` on a running headless install's 238-line log returned 0,
  so a healthy relay, a stalled poller and a run that never produced an answer
  were indistinguishable from outside the app - diagnosing "the agent hangs
  without output" required reading the session store off disk by hand. The
  relay now records each inbound update (command name, chat, character count),
  one line per relayed run with the replies and characters actually sent, when
  it is blocked on an unanswered approval, a stalled poller, poll failures with
  their backoff, mirror messages it gave up on, and why it did not start. No
  message bodies, prompts or model output are logged: the file is read next to
  the session store, but it is also what people paste into a bug report.
- **A log that fails can no longer fail what it describes.** `logInfo` reaches
  Tauri's `invoke`, which rejects outside the app, and `void` on that promise
  left an unhandled rejection that turned a fully-passing test run into a
  failed one. The relay's log emit swallows its own failure.

### Fixed

- **DeepSeek Flash was treated as a small model.** `deepseek-v4-flash` was in
  the lite tier, so it got the shortened prompt and only the 27 core tools - 99
  of 126 were dropped. It is not a small model: it is DeepSeek's everyday
  reasoning tier (rated 4/5 intelligence, the same as `claude-sonnet-4-6`), it
  serves a 1M-token window, and it is the provider's *default* model, so this
  hit every DeepSeek user. Membership was decided by name association: "flash"
  reads small. The lite tier now says so explicitly and the entry is out.
- **The Codex models were filed at 400,000 tokens instead of 1,000,000.** The
  context indicator read four times fuller than it was and the conversation was
  pruned early - which reads as the agent forgetting context mid-task. Applies
  to `gpt-5.3-codex` and the ChatGPT-subscription `chatgpt-codex` pair, which
  route to the same backend.
- **A model on the compact tier that named a tool outside the pruned set ended
  the run instead of correcting itself.** The compact tier holds the agent to 27
  core tools, and the prune dropped `unknown_tool_fallback` in the same pass -
  the one tool that answers an unknown name. The AI SDK then raised a fatal
  `NoSuchToolError`. Observed on the DeepSeek endpoint (`model=compat-762d2bd6`,
  `before streamText (27 tools)`): the model asked for `git_push`, a real tool
  the prune had removed, and the reply was
  `Model tried to call unavailable tool 'git_push'` with no way back. The
  recovery tools (`unknown_tool_fallback`, `find_tools`) now survive every
  prune, `prepareStep` keeps them active in search mode, and the prune logs what
  it dropped and for which model, so a missing capability is visible instead of
  reading as the agent ignoring the request.
- **A sub-agent batch was warned about a file conflict that did not exist.**
  `run_subagents` compares the paths each task prompt mentions, and a bare
  basename carries no directory. Two audits, one of `modules/fs/` and one of
  `modules/pty/`, each listed `mod.rs` among its own directory's files, so the
  batch reported `task #0 and #1 both touch mod.rs - they may overwrite each
  other`. This repo alone has 12 distinct `mod.rs`. A path now has to identify
  one file - a directory component and an extension - before it can raise a
  warning.
- **The agent could not run the project's own checks.** `pnpm lint` worked
  (the allowlist matches the base command, `pnpm`) while `biome`, `tsc`,
  `vitest` and `knip` did not, so the moment a caller wanted one file
  (`biome lint src/x.ts`, `vitest run src/x.test.ts`) or a raw flag it got
  `command 'biome' is not in the agent allowlist` and had to route a read-only
  check through a PTY. The project toolchains - JS/TS (`biome`, `tsc`,
  `vitest`, `knip`, `vite`, `eslint`, `prettier`, `jest`, `mocha`, `playwright`,
  `size-limit`), Python (`ruff`, `black`, `mypy`, `pytest`, `flake8`, `isort`)
  and the Go/Rust helpers whose base command is not `go`/`cargo`
  (`golangci-lint`, `rustfmt`) - are now allowed. This does not widen the trust
  boundary: `node`, `python`, `bun`, `deno` and `pnpm` were already allowed and
  each can execute arbitrary code, so a linter or type checker is strictly less
  powerful than the interpreters beside it. An unknown binary is still refused
  with the message that names the PTY escape hatch (asserted by a test).
- **A rejected search pattern came back with no way forward.** `grep` runs
  ripgrep's engine (RE2 syntax: no look-around, no backreferences). Models write
  PCRE anyway, and the reply was the engine's own message - accurate, and silent
  about the replacement, so the next move was usually another guess. Observed:
  `parseInt\((?!\s*[A-Za-z_$][\w.$]*\s*,)` rejected with "look-around ... is not
  supported". The error now keeps the engine's message (including the caret that
  points at the offending column) and adds the specific rewrite, and the tool's
  schema names the two unsupported constructs up front so most patterns never
  fail.
- **A sub-agent audit that abandoned its task was filed as a completed
  review.** Three of four audits in one batch returned prose saying they could
  not see the code, and the store recorded every one as `done`:

  > "No actionable findings could be confirmed from this review - but that is a
  > statement about the evidence, not a clean bill of health..."
  > "Every body I was able to obtain consisted only of the import preamble."

  The claims were false: the tool layer had returned the full files. The same
  session's transcript shows `read_file` on `pty/session.rs` - a 409-line,
  14.8 KB file the audit said it could not read - returning 16.7 KB of content,
  and another audit described a `glob` result as JSON text "cut off mid-array",
  which a tool result (an object) cannot be. Sub-agent runs are now judged on
  their evidence: a review that declares itself incomplete, or that ran no
  tool calls, is flagged `[inconclusive]` in the summary, marked in the run
  store, shown as an amber "unverified" badge, and counted in the batch note, so
  an orchestrator cannot read it as a clean audit.

- **A pinned tool choice was sent to models we have no metadata for, and the
  provider rejected the whole request.** `modelAllowsForcedToolChoice` read
  `tags` off the model info, but `getCompatModelInfo` (and every freeform
  provider entry: OpenRouter custom, OpenAI-compatible custom, LM Studio, MLX,
  Ollama) builds its model WITHOUT a `tags` key. `undefined?.includes(...)` is
  falsy, so every one of them was treated as capable and step 0 of a broad
  request was pinned to `run_subagents`. A StepFun thinking-mode endpoint
  answered exactly what the module's own comment predicted:
  `status 400 - "Thinking mode does not support this tool_choice"`, on the first
  request of the run, before a token of work. Absence of metadata is not
  evidence of capability, so an unknown model is now treated as not allowing it.
  The model still has `run_subagents` and may choose it; pinning was an
  optimisation. `lib/toolChoiceLearning` stays the ground truth for a built-in
  whose tags are wrong.
- **A run of prose-free tool steps was treated as a loop, so productive work was
  terminated.** Two consecutive steps that called tools without emitting text
  requested a synthesis step, and the synthesis step ended the run whichever way
  it went - a summary, or an ignored pin. Reading eight files emits no prose
  between them, so the guard fired on work that was succeeding. The trajectory
  store shows the cost: a run of 8 varied, all-successful reads
  (`read_file` x7, `grep`) marked `failed`, another of 6 (`read_file` x5,
  `glob`) the same, after burning 199k and 75k tokens. A prose-free streak is
  not a loop; the guard is removed. Loop protection is unchanged - the same call
  three times (`noToolRepetition`), a tool that keeps failing
  (`noErrorProgress`), a model that narrates without acting (`noProgressStop`)
  and the step budget all still apply - and `requestSynthesisOrStop` still gives
  every real guard its final tool-less summary step.
  Follow-on: because an unknown endpoint was observed accepting the
  `toolChoice: "none"` pin without honouring it, synthesis is skipped for those
  models too. That keeps the guard's true reason (and with it `step-cap`'s
  auto-continue) instead of converting a paused useful run into
  `tool-only-loop`, which does not auto-continue.

### Added

- **On-demand tool loading.** The full toolset is ~80 KB of JSON Schema sent on
  every request. With Settings → Agents → *Load tools on demand* on, a run
  starts with the coding loop (39 tools / 31.4 KB / ~8.0k tokens) plus a
  `find_tools` search, and a domain joins the request when the model asks for it
  by keyword. Measured saving: 61% (~12.5k tokens per request) against the full
  125-tool set, with full capability kept - unlike the compact tier, this keeps
  `ask_user`, the file operations and the verification loop. `find_tools` costs
  1.1 KB and indexes the 87 deferred tools; a discovered tool stays active for
  the rest of the run, so re-use costs no extra step.
- **Tool domains** (Settings → Agents): switch off whole optional domains -
  browser, GitHub, LSP, web, skills, self-improvement, workflows, previews,
  agent handoff, PTY driving, worktrees, SQL, PDF, image generation, history -
  and their schemas leave the request. Every group off: 56 tools / 40.6 KB /
  ~10.4k tokens, a 49% cut. The core loop is deliberately not groupable.

### Fixed

- **An unknown tool call answered with a stale, wrong list.** The
  `unknown_tool_fallback` reply named 13 hardcoded tools, written when the
  toolset was smaller. A model asking for a real tool outside those 13 -
  `git_status`, `run_checks`, every browser and GitHub tool - was told it did
  not exist and gave up on the capability. The reply is now built from the
  toolset actually in the request, adds "did you mean" candidates, names the
  equivalent tool when the cross-ecosystem alias table knows one, and points at
  `find_tools` when the run loads tools on demand.
- **An unanswered approval could hold a run open indefinitely.** The approval
  queue auto-denies after five minutes, but the SDK approval path (a
  `needsApproval` tool call paused for the user) had no deadline, so a card the
  user did not answer left `agentMeta.status` on `awaiting-approval` with
  nothing saying for how long. Both paths now share the same five-minute window
  and a reason the user and the model can both read.
- **The run log under-reported the tool payload by more than half.** The tool
  component of the prompt measurement counted `inputSchema.jsonSchema`, which
  exists only on `jsonSchema()`-built MCP tools, and fell back to the
  description for everything else - so built-in Zod schemas were invisible and
  the line reported 37 KB where the real block was 79 KB. `lib/toolPayload.ts`
  converts each Zod schema to the JSON Schema that is serialised (cached per
  tool name), and a schema that cannot be converted is reported as
  `unmeasured` in the log rather than passed off as exact.
- **`grep` schema was not representable as JSON Schema.** A Zod `.transform()`
  normalising a bare string glob to a list made this the one tool whose schema
  could not be measured. The normalisation moved into `execute`, where the same
  behaviour is asserted end-to-end; the schema stays declarative.

- **Completion of the F-14 boundary: commands the fs-only audit missed**
  - **`sql_run`**: a local database file (`sqlite3` / `duckdb` connection) was
    passed straight to the client with no deny-list and no workspace check, so
    any database on disk - a browser profile, a password-manager store, a
    credential DB - could be opened from inside the agent. A local file
    connection now passes `validate_read` and `require_authorized`; a URL or a
    bare database name is server-resolved and needs no filesystem gate. The
    split is `local_db_path`, unit-tested.
  - **`ssh_sftp_upload`**: the local source path was read and shipped to the
    remote host unchecked. The module doc claimed only user-dragged absolute
    paths arrive, but that described the caller, not the command. It now passes
    the secret deny-list. The workspace registry is deliberately not applied,
    because uploading a file from outside the open project is legitimate.
  - **`ext_peek_zip` / `ext_install_from_zip`**: the chosen package path is now
    run through the deny-list before it is read.
  - **Enforcement**: `src-tauri/tests/command_authorization.rs` parses the
    registered command catalogue, finds every command taking a path-like
    parameter, and fails when its module consults neither the registry nor the
    deny-list. Exemptions are written down with a reason, and a companion test
    fails if an exempted command is renamed or removed. Verified by removing the
    `sql_run` check and watching the test name it.

- **Rust filesystem layer hardening**
  - **F-14 CRITICAL**: 20 of 21 `fs::*` commands resolved a path and applied
    the secret deny-list, but never consulted
    `WorkspaceRegistry::is_authorized` - the invariant that
    `docs/architecture/security-model.md` states. A compromised webview could
    read, write, or delete any non-deny-listed path on disk. Every read, write,
    and mutation `fs::*` command now takes the registry and refuses a path
    outside an authorized root via the new `workspace::require_authorized`
    (`fs_watch_remove`, which only releases a watch subscription and touches no
    data, is unchanged). The check is
    canonicalisation-safe: `WorkspaceRegistry::is_authorized_canonical`
    resolves the nearest existing ancestor and refuses an unresolved `..`, so
    the component-wise `starts_with` cannot be traversed around.
  - **F-09 MEDIUM**: `fs_stat` was the only read command with no deny-list at
    all, leaking existence/size/mtime for `~/.ssh/id_rsa`, `/etc/shadow`, and
    every other secret path. It now routes through `validate_read` like the
    rest.
  - **F-10 MEDIUM**: `atomic_write` staged into the deterministic
    `.<name>.termigo.tmp`, so a pre-planted symlink there redirected the write
    and truncated the link target - exactly the attack the random-suffix
    `write_atomic` in `file.rs` already defends against. Staging now uses a
    per-write randomised sibling opened with `O_EXCL`.
  - **F-11 MEDIUM**: `fs_grep_interactive` ran a synchronous full-tree walk on
    the UI thread: it froze the UI and blocked the next query from bumping the
    generation counter, so its own supersession cancellation could never fire.
    It is now `async` + `spawn_blocking`, matching `fs_grep`.
  - **F-12 HIGH**: `fs_copy` used drag-drop sources literally (never resolved,
    never checked) and recursed with `std::fs::copy`, following symlinks with
    no per-entry check - a symlink inside a copied tree pointing at `~/.ssh`
    was copied by target, and a self-referential link looped. `copy_recursive`
    now skips symlinks and re-applies the deny-list to every child.
- **MCP scope test**: `project_scope_overrides_user_scope_for_the_same_name`
  used `project-cmd` / `user-cmd`, which the F-04 command allow-list rejects,
  so the project entry was dropped and the assertion failed. The fixture now
  uses allow-listed executables (`node` / `npx`).

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
