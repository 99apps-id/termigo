# TERMIGO.md

Termigo loads `TERMIGO.md` from the workspace root as agent memory (like AGENTS.md / CLAUDE.md), and it is the project's living architecture doc. Only the first 10k characters reach the agent, so keep what matters here and put detail in `docs/`.

## Project

**Termigo**: open-source AI-native terminal emulator. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + xterm.js (webgl) client, BYOK AI via Vercel AI SDK v6.

Bundle id `id.99apps.termigo`, package manager **pnpm**, platforms macOS / Linux / Windows.

Checks: `pnpm lint`, `pnpm check-types`, `pnpm test`; and in `src-tauri/`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo nextest run --locked` (fallback `cargo test --locked`).

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these:

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight (~7-8 MB bundle, high-performance terminal). Minimize RAM, avoid redundant IPC round-trips, extra re-renders, or heavy dependencies. Unused features consume zero resources.
- **Security**: validate at every boundary (IPC, fs, network, AI tool surface). The secret-path deny-list applies on both read and write and is never bypassed.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: functional core, thin imperative shell. Pure testable functions for logic; thin Tauri commands and React components.

Verify: `pnpm lint`/`check-types`/`test`; Rust `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`. A core-subsystem change needs a test that locks the invariant.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn. Modern pnpm uses junctions/symlinks on Windows; do not force `node-linker=hoisted`.
- **Branding**: `termigo.png` at repo root is master logo. After changing it run `node scripts/generate-logo.mjs` to regenerate `public/logo.png` and `src-tauri/icons`; never hand-edit those. Render `/logo.png` in UI, not a CSS lookalike.

## Architecture

### Two-process model

Rust owns every OS capability; the webview asks through `invoke()`. Commands are grouped `pty::*`, `fs::*` (`file`, `search`, `grep`, `mutate`), `shell::*`, `ssh::*`, `lsp::*`, `ai::*`, `secrets::*`, `mcp::*`.

Two rules hold everywhere: **no OS access from the frontend**, and a new command that is not in the capability allowlist does not exist. Long output streams over channels rather than returning in one piece.

Command catalog, module map and how to add a command: [two-process model](docs/architecture/two-process-model.md).

### PTY shell integration

Shell init scripts emit **OSC 7** (cwd) and **OSC 133** (prompt/command markers); the Rust reader parses them off the byte stream. Windows goes through ConPTY.

Invariant: **never serialize a pane mid-command.**

Init scripts, `SPAWN_LOCK`, Job Object, WSL: [PTY shell integration](docs/architecture/pty-shell-integration.md).

### Frontend (`src/`)

Single-window React app, path alias `@/*` -> `src/*`. Tabs are a tagged union on `kind` (terminal, editor, preview, markdown, ai-diff, git-diff, git-history, git-commit-file) and are **not** unmounted on switch: they hide via `invisible pointer-events-none`, so PTYs and dev servers keep streaming.

`App.tsx` wires modules together: keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Details in [module layout](docs/architecture/module-layout.md):

- **terminal/** xterm panes, renderer pool, splits. **editor/** CodeMirror 6, LSP client, diffs. **explorer/** file tree. **preview/**, **markdown/** preview surfaces.
- **tabs/** tab list and active id (source of truth). **spaces/** projects with own root, env, tabs. **workspace/** Local and WSL.
- **header/**, **statusbar/**, **sidebar/**, **command-palette/**, **shortcuts/** app chrome and keymap registry. **theme/**, **settings/**, **updater/**.
- **source-control/**, **git-history/** staging, commits, diffs, commit graph. **lsp/** opt-in language servers.
- **ssh/** remote tabs, host-key TOFU, SFTP explorer. **extensions/** manifest + worker sandbox. **agents/** agent lifecycle. **ai/** agentic subsystem.

### Go CLI (`cli/`)

Automation companion (`cli/cmd/termigo`): `doctor`, `init`, `agent run`, `skill`, `mcp`, `config`, and terminal control (`tui`, `setup`, `models`, `model`, `settings`, `approval`, `secret`) via `internal/control`. Keep dependency-light (stdlib + yaml.v3). Provider credentials stay with their CLIs; app API keys are stored only by the app.

### AI subsystem (`src/modules/ai/`)

BYOK, cloud and local, with `PROVIDERS` and the model registry in `config.ts`. Providers, run loop, sessions, composer, transport and how to add a provider: [AI subsystem](docs/architecture/ai-subsystem.md).

The parts that are invariants rather than description:

- **Keys** live in the OS keychain via `secrets_*` (on Linux, a `0600` `secrets.json` in the app data dir). Never persist a key to disk, settings, or `localStorage`.
- **Agent** (`lib/agent.ts`): keep `Agent` / `DirectChatTransport` shape adhering to AI SDK v6 semantics. Stop reasons report by name. Budgets escalate per Continue: `[25, 50, 100]`.
- **Subagents** (`lib/subagentPool.ts`, `agents/runSubagent.ts`): active concurrent subagents are managed by a global pool (`SubagentConcurrencyPool`, default 4). Parents yield their slot to child tasks via `ctx.yieldSlot()` to prevent deadlock. Batch subagents are concurrency-bounded (max 2 nested). Local subagents isolate workspace root from remote SSH tabs. Transient concurrency/rate limits retry with backoff.
- **Tools & Repair** (`tools/tools.ts`, `lib/repairToolCall.ts`): inspection tools auto-execute; mutating tools require approval. `lib/security.ts` denies secret paths (`.env*`, `.ssh/`, credentials) on read and write. Tool calls automatically repair parameter aliases (`query`/`path` on `grep`/`glob`, `max_results` clamped on `code_search`, string-to-array on `replace_in_files`) and near-miss tool names.
- **Shell sandbox allowlist** (`src-tauri/src/modules/shell/mod.rs`): `cmd`, `cmd.exe`, `powershell`, `pwsh`, and `set` are allowlisted on Windows while enforcing argument sanitization and risk-checking.
- **Approval resume - trailing message is load-bearing**: `streamText` finds approvals only in `messages.at(-1)`. Nothing may be appended after an answered approval.
- **Memory path**: learned memory loads from `.termigo/memory.md` in the workspace root (project scope). A global fallback at `~/.termigo/memory.md` is also loaded when the project file is absent. Keys never persist to disk, settings, or `localStorage`; they live in the OS keychain via `secrets_*`.

### UI conventions

- **shadcn/ui** primitives (`src/components/ui/`, style `radix-luma`, icons **hugeicons**) and **AI Elements** (`src/components/ai-elements/`) are generated: regenerate with `pnpm dlx shadcn add`, never hand-edit. Composition wrappers belong in `modules/<area>/components/`.
- **Tailwind v4**: no `tailwind.config.*`; config is `src/App.css` via `@theme`. Use `cn()` from `@/lib/utils`. Animation `motion`, layout `react-resizable-panels`.
- **Imports**: path imports are always `@/...`, never relative across modules.
- **Canonical paths**: forward-slash form on the frontend. `homeDir()` returns backslashes on Windows: convert at the boundary. Split anything from OSC 7, explorer, or OS on both separators (`/` and `\`), never `/` alone: equal canonical strings prevent `useFileTree` from clearing its tree on `tab.cwd` updates.

### Platform, capabilities and bundle

Per-platform window styling, the capability allowlist and bundle / updater config: [platform and bundle](docs/architecture/platform-and-bundle.md). The rules that bite if forgotten:

- A plugin API the webview may call must be in `src-tauri/capabilities/default.json`, or it does not exist.
- HOME / cache dirs come from the `dirs` crate, never raw `$HOME` / `%USERPROFILE%`.
- Gate Unix-only shell logic behind `#[cfg(unix)]`; the Windows arm lives in `pty::shell_init::windows`.
- Terminal input sends `\r` (CR) for Enter, never `\n` - PowerShell on Windows requires CR.

### Known gotchas

- **React 19 state and dev mode**: `setActiveId` is called outside `setTabs` updaters in `useTabs.ts` to preserve concurrent-mode consistency. `useTerminalSession` tracks `openSession` via ref to avoid stale closures. In dev, `useEffect` double-mounts; `SPAWN_LOCK` serializes early PTY cleanup (don't be alarmed by `pty opened` followed by `pty closed` in dev logs).
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `pty/job.rs` handles this for the Termigo-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` -> `C:`). Anything consuming `tab.cwd` for Rust fs commands on Windows must normalize separators or accept both: `apply_common` in `pty::shell_init` handles this for PTY spawn.

## Further reading

Contributor guides live under `docs/`. If anything conflicts, `TERMIGO.md` wins.
`docs/README.md` indexes them: `docs/architecture/` (module-layout, two-process-model, pty-shell-integration, ai-subsystem, security-model, platform-and-bundle, terminal-renderer-pool, cli-control) and `docs/contributing/` (testing).
