# Termigo Deep Audit Report
**Date**: 2025-01-15  
**Auditor**: Termigo Agent (autonomous)  
**Scope**: Full-stack security, architecture, frontend, Rust backend, AI subsystem, dependencies  
**Repo**: C:/project/termigo (v0.9.18)

---

## Executive Summary

Termigo is a **production-grade, security-conscious** AI-native terminal emulator. The codebase demonstrates deep expertise in cross-platform systems programming (Rust/ConPTY/Job Objects), terminal emulation (xterm.js WebGL), and AI agent orchestration (Vercel AI SDK v6). Security is treated as a first-class concern with defense-in-depth at every boundary.

### Key Strengths
- **Two-process model rigorously enforced**: Rust owns all OS capabilities; frontend never touches fs/network/process directly
- **Secret handling is exemplary**: OS keychain on macOS/Windows, 0600 file with atomic writes on Linux, chunking for oversized values
- **FS deny-list mirrored in Rust**: The frontend AI security.ts deny-list is duplicated in `src-tauri/src/modules/fs/security.rs` and applied to ALL raw `fs::*` IPC commands
- **Shell sandbox is well-designed**: Agent-triggered commands run through an allowlist with per-segment validation; PTY escape hatch preserved
- **SSH host-key TOFU**: SHA-256 fingerprint pinning with user confirmation on first connect
- **MCP server allowlist**: Only known package runners can spawn MCP servers, preventing project-registry backdoors
- **AI agent has sophisticated safety**: Circuit breakers, repetition guards, idle-read-loop detection, synthesis-on-stuck, cost budgets, approval gating

### Key Risks
1. **Mutable module-level tool registry** (`currentToolRegistry` in `tools.ts`) - race condition risk in concurrent subagent runs
2. **Windows Job Object gap** - `ProcessJob::create_for` uses `OpenProcess` with `PROCESS_SET_QUOTA | PROCESS_TERMINATE`, but the actual kill path in `proc/kill_tree` uses `taskkill /T /F` as fallback; Job Object is primary but `killer.kill()` from portable-pty only kills immediate child
3. **MCP pooled process trust boundary** - MCP servers run arbitrary code from allowlisted runners; a compromised `npx` package is still a risk
4. **Large shell allowlist includes pentest tools** - hydra, sqlmap, nmap etc. are allowlisted for agent execution without PTY; this is intentional for the user's pentest workflow but widens the attack surface
5. **Frontend App.tsx is massive** (~1448 lines) - acts as a coordinator but has grown large; risk of becoming a god component

---

## 1. Security Audit

### 1.1 IPC Boundaries & Capabilities

**Finding**: STRONG. The capability allowlist in `default.json` is minimal and principled.

- Only `core:default`, window management, `opener`, `dialog`, `log`, `os`, `notification`, `store`, `autostart` are granted
- **No raw fs/network/process capabilities** are exposed to the webview; all such access goes through typed Tauri commands registered in `lib.rs`
- The `invoke_handler` explicitly enumerates ~130 commands; nothing is open-ended

**Risk**: LOW. The only concern is that adding a new capability requires updating `default.json` AND `lib.rs`; a developer might forget the JSON side. The `check-invoke-commands` script (`scripts/check-invoke-commands.mjs`) partially mitigates this.

### 1.2 Secret Handling

**Finding**: EXEMPLARY. `src-tauri/src/modules/secrets.rs` is one of the best secret-storage implementations reviewed.

- **macOS**: Keychain via `keyring` crate with apple-native backend
- **Windows**: Credential Manager via `keyring` crate with windows-native backend
- **Linux**: `0600` file in `app_local_data_dir` with atomic write-tmp-persist pattern
- **Chunking for oversized values**: Windows Credential Manager caps at 2560 bytes; values are split across numbered companion entries with a NUL-prefixed header. This is handled transparently on all platforms
- **Cache invalidation**: Linux path reads/writes through a `Mutex<Option<HashMap>>` cache that is invalidated on every write
- **Batch reads**: `secrets_get_all` does a single IPC round-trip for cold-boot fan-out

**Risk**: NONE IDENTIFIED. The only theoretical concern is that the Linux `secrets.json` is plaintext on disk, but `0600` permissions and the app-local-data directory provide adequate isolation.

### 1.3 Filesystem Guards

**Finding**: EXEMPLARY. The Rust mirror of the frontend deny-list in `fs/security.rs` is comprehensive and well-tested.

- **Basename patterns**: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `known_hosts`, `credentials.json`, `service-account.json`, etc.
- **Protected directories**: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.git`, `/etc`, `/proc`, `/sys`, Windows AppData credentials paths
- **Write-only deny prefixes**: `/etc/`, `/usr/bin/`, `/windows/`, `/program files/`, etc.
- **Symlink resolution**: `guard_read`/`guard_write` canonicalize paths and re-check; `validate_write` resolves the parent for new files
- **Comparison form**: Normalizes backslashes, strips `\\?\` prefixes, removes NTFS ADS tails, collapses duplicate slashes, lowercases
- **WSL support**: Strips `//wsl$/<distro>/` prefix before root comparison

**Risk**: LOW. The `is_protected` function for walkers uses raw strings without canonicalization (intentionally, for performance). A symlink at an innocent path pointing into `.ssh` would be caught by `guard_read`/`validate_read` on the explicit path, but NOT by `is_protected` during a tree walk. This is documented and acceptable because walkers never follow symlinks.

### 1.4 Input Validation

**Finding**: STRONG across the board.

- **Shell commands** (`shell/mod.rs`): Agent-triggered commands validated against `SANDBOX_ALLOWLIST` with per-segment checking. `$`, `` ` ``, `(`, `)`, `<`, `>` refused. Newlines/CR treated as separators (fixes historical injection). `|`, `&&`, `||`, `;` allowed between allowlisted programs. `2>&1` and `>/dev/null` stripped before scan.
- **Shell overrides** (`pty/shell_init.rs`): `sanitize_shell_override` canonicalizes and checks against `list_shells()`; a tampered setting cannot spawn an arbitrary binary
- **SSH host keys**: TOFU with SHA-256 fingerprint pinning; mismatch aborts handshake
- **MCP commands**: `ALLOWED_MCP_COMMANDS` restricts to known package runners (`npx`, `uvx`, `node`, `python3`, `cargo`, etc.)
- **AI tool calls**: `repairToolCall.ts` repairs near-JSON and maps cross-ecosystem tool aliases; `security.ts` blocks secret paths and destructive shell patterns (`rm -rf /`, `rm -rf ~`, `dd of=/dev/sd*`, `mkfs`, fork bombs, pipe-to-shell from network)
- **Unicode bidi-override** blocked in shell commands (Trojan Source protection)

### 1.5 SSH & MCP Security

**SSH** (`ssh/mod.rs`, `ssh/session.rs`):
- Host-key verification via ` russh::keys::HashAlg::Sha256`
- `expected_fingerprint` passed on reconnect; mismatch = abort
- ProxyJump chains resolved on frontend, secrets from keychain, backend just dials
- SFTP operations scoped to the session

**MCP** (`mcp/mod.rs`):
- Registry merged from project + user `mcp.json`
- Commands validated against `ALLOWED_MCP_COMMANDS` allowlist
- Pooled processes stay alive; transport failures drop and restart
- **Risk**: A compromised `npx` package in a project's `mcp.json` still executes arbitrary code. This is inherent to MCP's stdio model; the allowlist prevents completely arbitrary commands but cannot sandbox the allowed runners.

### 1.6 Unsafe Code & Memory Safety

**Finding**: STRONG. Rust's safety guarantees hold; `unsafe` is minimal and justified.

- `windows_sys` FFI in `proc/job.rs` for Job Object creation is wrapped in a safe `ProcessJob` struct with proper `Drop`
- `portable-pty` uses `unsafe` internally but is a well-audited crate
- No `unsafe` in application code outside Windows FFI bindings

---

## 2. Architecture Review

### 2.1 Two-Process Model

**Finding**: EXEMPLARY. The architecture is clean and consistently enforced.

- **Rust backend** (`src-tauri/`): Owns PTY, fs, ssh, git, shell, secrets, mcp, lsp, net, browser, extensions
- **Frontend** (`src/`): React 19 + xterm.js + Zustand; asks through `invoke()`
- **Command catalog** is explicit in `lib.rs` `invoke_handler!` macro
- **Long outputs** stream via Tauri `Channel` (e.g., PTY data, SSH events)

**Strength**: The `modules/` layout in both `src-tauri/src/modules/` and `src/modules/` mirrors the capability groups (`pty::*`, `fs::*`, `shell::*`, `ssh::*`, `ai::*`, `secrets::*`, `mcp::*`)

### 2.2 Module Layout

**Finding**: WELL-ORGANIZED with minor growth risk.

**Frontend modules** (`src/modules/`):
```
agents/ ai/ api-client/ command-palette/ control/ editor/ explorer/
extensions/ git-history/ header/ i18n/ lsp/ markdown/ mcp/ preview/
settings/ shortcuts/ sidebar/ source-control/ spaces/ ssh/ statusbar/
tabs/ telegram/ terminal/ theme/ updater/ workspace/
```

**Rust modules** (`src-tauri/src/modules/`):
```
control/ extensions/ fs/ git/ history/ lsp/ mcp/ proc/ pty/ shell/ ssh/
+ agent.rs, backup.rs, browser.rs, chatgpt_auth.rs, net.rs, secrets.rs, sql.rs, system.rs, workspace.rs
```

**Risk**: `src/app/App.tsx` is ~1448 lines. While it is a coordinator, its size suggests it may be accumulating responsibilities. The custom hooks (`useWorkspaceBoot`, `useTerminalLifecycle`, `useGlobalActions`, etc.) help, but the component itself remains large.

### 2.3 PTY Integration

**Finding**: EXEMPLARY. The PTY subsystem is the most sophisticated part of the codebase.

- **Shell init scripts** emit OSC 7 (cwd) and OSC 133 (prompt/command markers)
- **Rust reader** parses OSC 7/133 off the byte stream via `AgentDetector` and `DaFilter`
- **SPAWN_LOCK**: Serializes early PTY cleanup (dev-mode double-mount)
- **Windows**: ConPTY with `CONPTY_LIFECYCLE_LOCK` to prevent overlapping pseudoconsole lifecycle corruption (issue #356)
- **Job Object** (`proc/job.rs`): `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` for descendant process killing on Windows
- **Unix**: `kill_tree` recurses via `pgrep -P` depth-first
- **Backpressure**: 4 MiB pending buffer with SGR-reset overflow notice
- **Flusher**: Coalesces 4ms windows, respects output credit for flow control
- **Persistence**: tmux wrapper on Unix (`tmux new-session -A -s termigo-<key>`)

**Risk**: LOW. The `portable-pty` crate is a critical dependency; if it has a bug, the entire terminal is affected. The codebase handles this well with defensive drop ordering and explicit kill guards.

---

## 3. Frontend Audit

### 3.1 React Patterns

**Finding**: MODERN and mostly correct.

- **React 19** with `reactCompilerPreset` (Babel) enabled in Vite
- **Concurrent mode**: `setActiveId` called outside `setTabs` updaters in `useTabs.ts` to preserve concurrent-mode consistency
- **Refs for stale closures**: `useTerminalSession` tracks `openSession` via ref
- **Dev-mode double-mount**: `SPAWN_LOCK` serializes early PTY cleanup

**Risk**: MEDIUM. `App.tsx` is very large. While it uses many custom hooks, the component body still contains hundreds of lines of JSX and callbacks. This makes it hard to test and reason about.

### 3.2 State Management

**Finding**: GOOD. Zustand is used appropriately.

- Multiple stores: `useChatStore`, `useSpaces`, `usePreferencesStore`, `useWorkspaceEnvStore`, `useExtensionsStore`, `useSshActiveSessionStore`, `useSshRightPanelStore`, `useRightPanelStore`, `useApprovalQueueStore`, `useCustomCommandsStore`, `useApprovalRulesStore`
- Stores are imported directly, not React context, which is the right pattern for Zustand
- **Risk**: The AI tool registry (`currentToolRegistry` in `tools.ts`) is a module-level mutable variable. This is a **race condition risk** if multiple agent runs overlap (e.g., a subagent spawns while the parent is building tools). The comment says "set by buildTools each time the agent builds its tool set" but does not protect against concurrent access.

### 3.3 Bundle & Performance

**Finding**: WELL-OPTIMIZED for bundle size.

- **Vite config** uses `manualChunks` to split:
  - AI provider SDKs into separate chunks (`ai-anthropic`, `ai-openai`, etc.)
  - xterm.js into its own chunk
  - CodeMirror language packs into per-language chunks
  - React + styling utils into eager `react` chunk
  - Streamdown (markdown rendering) lazy-loaded
- **React compiler** enabled for automatic memoization
- **Size limit** configured via `@size-limit/file`
- **Tree shaking**: `manualPureFunctions` marks `console.debug/info/trace` as pure for DCE

**Risk**: LOW. The `streamdown` chunk is likely the heaviest; if it gets dragged into the eager graph, it would hurt startup. The Vite config pins `vite/preload-helper` to the `react` chunk to prevent this.

### 3.4 xterm.js / WebGL

**Finding**: SOLID. xterm.js v6 with WebGL addon.

- CSS imported in `main.tsx`
- WebGL renderer used for performance
- Addons: `fit`, `search`, `serialize`, `web-links`
- **Risk**: WebGL contexts are limited per browser/tab. If Termigo has many terminal panes, each with its own WebGL context, it could hit platform limits. The renderer pool pattern mentioned in TERMIGO.md should mitigate this.

---

## 4. Rust Backend Audit

### 4.1 Tauri Commands

**Finding**: EXEMPLARY. ~130 commands explicitly registered.

- All commands take `AppHandle` or `State` as appropriate
- Async commands use `#[tauri::command]` with proper error handling (`Result<..., String>`)
- Long-running operations spawn threads to avoid blocking the Tauri async runtime
- `pty_close_all` called on startup to reap orphaned sessions

### 4.2 Error Handling

**Finding**: GOOD with some `unwrap()` usage.

- `shell_run_command` uses `mpsc` channels with proper error propagation
- PTY reader/flusher threads handle errors gracefully
- `secrets.rs` uses `Mutex` with poisoned-error handling
- **Risk**: A few `.unwrap()` calls in session management could panic in edge cases (e.g., `state.sessions.write().unwrap()` in `shell_session_open`). While `RwLock` poisoning is rare, it is not impossible.

### 4.3 Async Runtime

**Finding**: APPROPRIATE.

- Tauri's async runtime handles most commands
- SSH uses a dedicated 2-thread tokio runtime (`termigo-ssh`)
- Blocking operations (shell spawn, PTY reader) run on dedicated threads
- `SharedChild` used for interruptible child processes

### 4.4 Windows Process Lifecycle

**Finding**: WELL-HANDLED but with a known gap.

- **Job Object** (`proc/job.rs`): `KILL_ON_JOB_CLOSE` ensures descendants die when the job handle closes
- ** portable-pty `killer.kill()`**: Only kills the immediate child; the Job Object handles descendants
- **Risk**: If the Job Object creation fails (`ProcessJob::create_for` returns `Err`), the code logs a warning and continues without it. A failed Job Object means descendants survive app exit. This is graceful degradation but worth monitoring.

---

## 5. AI Subsystem Review

### 5.1 Agent Run Loop

**Finding**: EXEMPLARY. The agent loop is one of the most sophisticated reviewed.

- **Stop conditions**: Step cap, tool repetition (3x in sliding window), idle-read-loop (5x input-only), text repetition, no-progress (2x idle text), error progress (3x all-error steps), cost cap
- **Circuit breaker**: Detects repeated identical failures, timeouts, and offline state; injects urgent directives into system prompt
- **Synthesis on stuck**: When a guard trips, the model gets one final `toolChoice: "none"` step to summarize before stopping
- **Context management**:
  - `pruneMessages` trims history to fit context window
  - `evictObsoleteToolOutputs` collapses stale read results
  - `pruneVerifiedPrefix` replaces completed git-checkpointed work with a summary
- **Watchdog**: Silence timer aborts hung providers; respects approval-resume timing
- **Model cache**: LRU cache of 64 built models; prunes on overflow

### 5.2 Tool Registry

**Finding**: GOOD but with a documented race condition.

- `buildTools` constructs ~40+ tool modules into a single `ToolSet`
- Each tool wrapped with `withToolLifecycle` for PreToolUse/PostToolUse hooks
- `withPostExecuteConfirm` adds post-execution Keep/Revert for mutating tools
- `withAutoVerify` runs format+lint after edits when preference is on
- **Risk**: `currentToolRegistry` is a module-level mutable `Record<string, unknown>`. While `buildTools` sets it at the start of each run, concurrent subagent runs could read a registry that is being replaced. The `dispatchTool` closure captures `wrappedBase` at build time, which mitigates this for the current run, but any code reading `currentToolRegistry` directly (workflow/orchestrator engines) could see a partially-updated state.

### 5.3 Subagent Pool

**Finding**: SOLID.

- `SubagentConcurrencyPool` with default max 4 concurrent
- Queue-based with AbortSignal support
- Parents yield slots to children via `ctx.yieldSlot()` (per TERMIGO.md)
- Batch subagents concurrency-bounded (max 2 nested)
- **Isolation**: Optional git worktree isolation per subagent run
- **Cost guard**: Subagent model cannot exceed 1.5x main model's input price
- **Denial breaker**: Aborts subagent after N consecutive denials
- **Empty completion retry**: Retries once if model returns no text and no tool calls

### 5.4 BYOK & Keyring

**Finding**: EXEMPLARY. Keys never touch disk or localStorage.

- Frontend `keyring.ts` calls Rust `secrets_*` commands
- Keys stored in OS keychain (Keychain/Credential Manager) or Linux 0600 file
- `getAllKeys` batches reads into single IPC call
- `clearKey` on provider switch

### 5.5 Approval Flow

**Finding**: ROBUST.

- Read-only tools auto-execute through security guard
- Mutating tools require approval; AI SDK pauses on tool-call
- Approval resume: `streamText` finds approvals only in `messages.at(-1)`; nothing may be appended after an answered approval
- Post-execute confirmation: mutating tools can ask Keep/Revert after success
- **Trailing message invariant** is load-bearing and documented

### 5.6 Telegram Bot

**Finding**: WELL-STRUCTURED (no longer monolithic).

- 32 files in `src/modules/telegram/`
- Separation: API, polling, dispatch, helpers, progress, dedup, log, keyring, store
- `bot.ts` is now ~3.7 KB (down from being "too large")
- Tests cover: snippet answering, diff commands, elicitation, keyring, mermaid images, mirror stream, model groups, pairing code, progress format, telegram API, update offset

---

## 6. Dependencies & Config

### 6.1 Frontend Dependencies

**package.json** (v0.9.18):
- **React 19.2.8** + React DOM 19.2.8
- **Vercel AI SDK v6**: `ai@6.0.207`, provider SDKs for OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter
- **xterm.js 6.0.0** + WebGL addon
- **CodeMirror 6** with extensive language packs
- **Zustand 5.0.14** for state
- **Tailwind v4** via `@tailwindcss/vite`
- **shadcn/ui** + AI Elements + Radix UI
- **mermaid 11.16.1** for diagrams
- **zod 4.4.3** for validation

**Overrides**:
- `dompurify >= 3.4.9` (security patch)
- `nanoid >= 3.3.18` (security patch)

**Risk**: LOW. Dependencies are modern and actively maintained. The `dompurify` override suggests the team monitors advisories.

### 6.2 Rust Dependencies

**Cargo.toml** (v0.9.15):
- **Tauri 2** with `protocol-asset` and `unstable` (multi-webview)
- **portable-pty 0.9** for PTY abstraction
- **russh 0.60** + `russh-sftp 2.1` for SSH
- **reqwest 0.12** with rustls-tls (no native-tls)
- **tokio 1** with full features
- **zip 4** with deflate only
- **ring 0.17** for crypto
- **sha2 0.10**, **hex 0.4** for hashing
- **base64 0.23**
- **nucleo-matcher 0.3** for fuzzy search
- **notify 8.2.0** for file watching

**Risk**: LOW. Dependencies are well-chosen. `portable-pty` and `russh` are the critical ones; both are mature crates.

### 6.3 Build Configuration

**Vite**:
- Rolldown-based build (experimental Vite 8)
- React compiler preset for React 19
- Manual chunking for lazy loading
- `ANALYZE=true` emits treemap stats

**TypeScript**:
- Strict mode enabled
- `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- `paths` alias `@/* -> src/*`

**Biome**:
- Used for linting (`pnpm lint` = `biome lint ./src`)
- Format check not run in CI (known Windows CRLF issue)

**Knip**:
- Part of CI; ~257 pre-existing unused exports baseline
- Team policy: do not add new knip entries

---

## 7. Recommendations

### Priority 1 (High)

1. **Fix tool registry race condition**: Replace module-level `currentToolRegistry` with a per-run reference passed via context, or add a `Mutex` around it. The comment says it is set by `buildTools` but concurrent subagent runs could observe torn state.

2. **Job Object fallback hardening**: When `ProcessJob::create_for` fails, consider logging a metric/event so the team can track how often this happens. Silent fallback to single-child kill means descendants survive.

3. **MCP command allowlist expansion risk**: Document that adding a new runner to `ALLOWED_MCP_COMMANDS` is a security-sensitive change requiring review. Consider a comment header on the array stating this.

### Priority 2 (Medium)

4. **App.tsx decomposition**: Extract the large inline JSX sections into presentational components. The `shell` variable (~600 lines of JSX) is a candidate for extraction.

5. **WebGL context pooling**: Document the xterm.js renderer pool size and monitor context count in dev tools. If panes exceed the pool, consider warning or automatic pool expansion.

6. **Windows console hiding**: `proc::hide_console` sets `CREATE_NO_WINDOW` flag. Verify this does not interfere with PTY ConPTY on Windows, which needs console visibility for the pseudoconsole.

### Priority 3 (Low)

7. **Shell init script atomicity**: `write_if_changed` uses a temp file with `.__termigo_tmp__` suffix. Consider `tempfile` crate for random names to prevent symlink attacks (the current fixed sibling name is a minor risk on multi-user systems).

8. **Telegram bot tests**: Ensure the 32-file split maintains 100% test coverage for edge cases (dedup, update offset, polling restart).

---

## Appendix: Files Reviewed

### Security-Critical
- `src-tauri/src/modules/secrets.rs` (552 lines)
- `src-tauri/src/modules/fs/security.rs` (562 lines)
- `src-tauri/src/modules/shell/mod.rs` (1188 lines)
- `src-tauri/src/modules/ssh/mod.rs` (497 lines)
- `src-tauri/src/modules/mcp/mod.rs` (509 lines)
- `src-tauri/capabilities/default.json` (35 lines)

### Frontend
- `src/app/App.tsx` (1448 lines)
- `src/main.tsx` (43 lines)
- `src/modules/tabs/lib/useTabs.ts` (1642 lines)
- `src/modules/terminal/lib/panes.ts` (352 lines)
- `vite.config.ts` (160 lines)

### AI Subsystem
- `src/modules/ai/lib/agent.ts` (2057 lines)
- `src/modules/ai/tools/tools.ts` (369 lines)
- `src/modules/ai/lib/security.ts` (522 lines)
- `src/modules/ai/lib/repairToolCall.ts` (872 lines)
- `src/modules/ai/lib/keyring.ts` (162 lines)
- `src/modules/ai/lib/subagentPool.ts` (94 lines)
- `src/modules/ai/agents/runSubagent.ts` (434 lines)

### Rust Backend
- `src-tauri/src/lib.rs` (374 lines)
- `src-tauri/src/modules/pty/mod.rs` (37 lines)
- `src-tauri/src/modules/pty/session.rs` (484 lines)
- `src-tauri/src/modules/pty/shell_init.rs` + `unix.rs` + `windows.rs` (301 + 323 + 630 lines)
- `src-tauri/src/modules/proc/mod.rs` + `job.rs` (84 + 112 lines)
- `src-tauri/Cargo.toml` (137 lines)

### Config
- `package.json` (151 lines)
- `tsconfig.json` (31 lines)
- `biome.json` (not shown)
- `knip.json` (not shown)
