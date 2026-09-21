# AGENTS.md

Read `TERMIGO.md` first. It is the living architecture doc and source of truth. On conflict, `TERMIGO.md` wins over this file and over `docs/`.

## Project snapshot

Termigo: open-source AI-native terminal emulator. Tauri 2 + Rust (`portable-pty`) backend in `src-tauri/`, React 19 + TypeScript + xterm.js client in `src/`, Go automation companion in `cli/`. Package manager `pnpm` only. See `TERMIGO.md` and `docs/README.md` for the module map.

## Audit and evaluation rules for Muse agent

1. Default to read-only. Do not write code, edit files, run mutating commands, or persist memory unless the user explicitly asks for a fix.
2. Never read or exfiltrate secrets: OS keychain, `.env*`, `.ssh/`, credentials, API keys. `.gitignore` already excludes secret and scratch artifacts; keep it that way.
3. Validate at every boundary you inspect: Tauri IPC allowlist (`src-tauri/capabilities/default.json`), workspace authorization, shell sandbox allowlist (`src-tauri/src/modules/shell/mod.rs`), AI tool approval surface, SSRF guard on network fetch.
4. Ground every finding in a real file and line: path plus symbol or command name. No hallucinated imports or phantom paths. Cross-check frontend `invoke("...")` names against Rust `generate_handler!` via `pnpm check:commands`.
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

## Reporting

Write findings by severity (Critical, High, Medium, Low) with file, reproduction or proof, and suggested fix. Prior reports used as format reference: `AUDIT-REPORT.md`, `AUDIT-2025-06-28.md`. Security issues follow `SECURITY.md` (report to security@termigo.app, no public issue).

Detailed audit checklist: `docs/contributing/muse-audit.md`.
