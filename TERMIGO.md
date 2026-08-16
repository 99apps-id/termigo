# TERMIGO.md

Termigo loads `TERMIGO.md` from the workspace root as agent memory (like AGENTS.md / CLAUDE.md), and it is the project's living architecture doc. Only the first 10k characters reach the agent, so keep what matters here and put detail in `docs/`.

## Project

**Termigo**: open-source AI-native terminal emulator. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + xterm.js (webgl) client, BYOK AI via Vercel AI SDK v6.

Bundle id `id.99apps.termigo`, package manager **pnpm**, platforms macOS / Linux / Windows.

Checks: `pnpm lint`, `pnpm check-types`, `pnpm test`; and in `src-tauri/`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo nextest run --locked` (fallback `cargo test --locked`).

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, AI tool surface). The secret-path deny-list applies on both read and write and is never bypassed.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell). Keeps it testable without a later rewrite.

Verify before claiming done:

- Frontend: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (or `cargo test --locked`)

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, IPC or AI tool surface) needs a test that locks the invariant.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn.
- **Branding**: `termigo.png` at the repo root is the master logo and is an
  input, never generated. After changing it run `node scripts/generate-logo.mjs`
  to regenerate `public/logo.png` and the whole `src-tauri/icons` set; never
  hand-edit those. In the UI render the `/logo.png` asset, not a CSS lookalike.

## Architecture

### Two-process model

Rust owns every OS capability; the webview asks through `invoke()`. Commands are grouped `pty::*`, `fs::*` (`file`, `search`, `grep`, `mutate`), `shell::*`, `ssh::*`, `lsp::*`, `ai::*`, `secrets::*`, `mcp::*`.

Two rules hold everywhere: **no OS access from the frontend**, and a new command that is not in the capability allowlist does not exist. Long output streams over channels rather than returning in one piece.

Command catalog, module map and how to add a command: [two-process model](docs/architecture/two-process-model.md).

### PTY shell integration

Shell init scripts emit **OSC 7** (cwd) and **OSC 133** (prompt and command markers); the Rust reader parses them off the byte stream, so the frontend never has to guess where a shell is. Windows goes through ConPTY.

The invariant worth knowing before touching a terminal: **never serialize a pane mid-command.**

Init scripts per shell, `SPAWN_LOCK`, Job Object, WSL: [PTY shell integration](docs/architecture/pty-shell-integration.md).

### Frontend (`src/`)

Single-window React app, path alias `@/*` → `src/*`. Tabs are a tagged union on `kind` (terminal, editor, preview, markdown, ai-diff, git-diff, git-history, git-commit-file) and are **not** unmounted on switch - they hide via `invisible pointer-events-none`, so PTYs and dev servers keep streaming.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

One line each; every module in full, with the invariants that are easy to break, is in [module layout](docs/architecture/module-layout.md).

- **terminal/** xterm panes, renderer pool, splits - **editor/** CodeMirror 6, LSP client, inline completion, diffs - **explorer/** file tree - **preview/**, **markdown/** preview surfaces
- **tabs/** tab list and active id, the source of truth - **spaces/** projects with their own root, env and tabs - **workspace/** Local and WSL
- **header/**, **statusbar/**, **sidebar/**, **command-palette/**, **shortcuts/** app chrome and the keymap registry - **theme/**, **settings/**, **updater/**
- **source-control/**, **git-history/** staging, commits, diffs, commit graph - **lsp/** opt-in language servers, zero cost until enabled
- **ssh/** sessions as tabs, host-key TOFU, SFTP explorer, forwarding - **agents/** launching and notifications for coding agents - **ai/** the agent itself, below

### Go CLI (`cli/`)

The Go companion (`cli/cmd/termigo`) is the automation layer: `doctor`, `init`, `agent run`, `skill`, `mcp` and `config`. Keep it dependency-light (stdlib + yaml.v3); provider credentials stay with their own CLIs.

### AI subsystem (`src/modules/ai/`)

BYOK, cloud and local, with `PROVIDERS` and the model registry in `config.ts`. Providers, run loop, sessions, composer, transport and how to add a provider: [AI subsystem](docs/architecture/ai-subsystem.md).

The parts that are invariants rather than description:

- **Keys** live in the OS keychain via `secrets_*`. Never persist a key to disk, the settings store, or `localStorage`.
- **Agent** (`lib/agent.ts`): keep the `Agent` / `DirectChatTransport` shape - the rest of the system depends on AI SDK v6 chat semantics. Three stop conditions each record which tripped, so a stop is reported by name instead of as a bare cap. Budgets escalate per Continue: `[25, 50, 100]`.
- **Tools** (`tools/tools.ts`): `read_file`, `list_directory`, `grep`, `glob`, `get_terminal_output` auto-execute; mutating tools set `needsApproval: true`. `lib/security.ts` is a deny-list refusing obvious secret paths (`.env*`, `.ssh/`, credentials, keychain dirs) - apply it on **both** read and write paths and don't bypass it.
- **Approval resume - the trailing message is load-bearing.** `streamText` finds an approval only in `messages.at(-1)`, and only if that is the `tool` message carrying it, so **nothing may be appended after an answered approval** - the call then never runs and the provider rejects the history instead. `isResumingApproval` (`lib/transport.ts`) holds the `<env>` block back; anything else appending to the outgoing copy must check the same. Cost three releases to find: [why](docs/architecture/ai-subsystem.md#approval-resume-nothing-may-follow-the-approval).

### UI conventions

- **shadcn/ui** primitives (`src/components/ui/`, style `radix-luma`, icons **hugeicons**) and **AI Elements** (`src/components/ai-elements/`) are generated: regenerate with `pnpm dlx shadcn add`, never hand-edit. Composition wrappers belong in `modules/<area>/components/`.
- **Tailwind v4** - no `tailwind.config.*`; config is `src/App.css` via `@theme`. Use `cn()` from `@/lib/utils`. Animation `motion`, layout `react-resizable-panels`.
- Path imports are always `@/…`, never relative across modules.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows - convert at the boundary. Split anything that may come from OSC 7, the explorer or the OS on both separators, never on `/` alone: equal canonical strings are what keep `useFileTree` from wiping its tree when `tab.cwd` arrives.

### Platform, capabilities and bundle

Per-platform window styling, the capability allowlist and bundle / updater config: [platform and bundle](docs/architecture/platform-and-bundle.md). The rules that bite if forgotten:

- A plugin API the webview may call must be in `src-tauri/capabilities/default.json`, or it does not exist.
- HOME / cache dirs come from the `dirs` crate, never raw `$HOME` / `%USERPROFILE%`.
- Gate Unix-only shell logic behind `#[cfg(unix)]`; the Windows arm lives in `pty::shell_init::windows`.
- Terminal input sends `
` (CR) for Enter, never `
` - PowerShell on Windows requires CR.

### Known gotchas

- **React 19 strict mode** double-mounts `useEffect` in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `SPAWN_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `pty/job.rs` handles this for the Termigo-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.

## Further reading

Long-form contributor guides live under `docs/`. These guides elaborate on `TERMIGO.md`; if anything conflicts, `TERMIGO.md` wins.

`docs/README.md` indexes them. Under `docs/architecture/`: `module-layout` (every frontend module in full), `two-process-model` (IPC and command reference), `pty-shell-integration`, `ai-subsystem` (sub-agents, tools, approval, adding a provider), `security-model`, `platform-and-bundle`, `terminal-renderer-pool`, `cli-control`. Under `docs/contributing/`: `testing`.
