# AGENTS.md

Read `TERMIGO.md` first. It is the living architecture doc and source of truth. On conflict, `TERMIGO.md` wins over this file and over `docs/`.

## Project snapshot

Termigo: open-source AI-native terminal emulator. Tauri 2 + Rust (`portable-pty`) backend in `src-tauri/`, React 19 + TypeScript + xterm.js client in `src/`, Go automation companion in `cli/`. Package manager `pnpm` only. See `TERMIGO.md` and `docs/README.md` for the module map.

## Agent Guidelines

1. Operate pragmatically with full tool access (no sandbox, no path boundaries).
2. Agent and subagents are empowered to inspect, edit, build, and test autonomously to achieve the user goal.
3. Retain and support git worktree isolation for branch operations and subagent tasks.
4. Ground every finding and edit in real files and lines: path plus symbol or command name. No hallucinated imports or phantom paths. Cross-check frontend `invoke("...")` names against Rust `generate_handler!` via `pnpm check:commands`.
5. Judge against the quality bar in `TERMIGO.md`: correctness, performance (light bundle, no redundant IPC or re-renders), security, UI/UX, architecture (functional core, thin shell).

## Checks to run for evaluation

```bash
pnpm lint
pnpm check-types
pnpm check:commands
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings
cd src-tauri && cargo nextest run --locked # fallback: cargo test --locked
```

Reference: `docs/contributing/testing.md` and `.github/workflows/ci.yml`.

## Conventions

- No em-dash anywhere: code, comments, commits, docs.
- No emojis anywhere.
- Defer to `USER.md` for specific user preferences and workflow instructions.
