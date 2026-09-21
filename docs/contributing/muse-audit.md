# Muse audit guide

Checklist for a Muse agent auditing or evaluating this repo. `TERMIGO.md` is the source of truth; this file only sequences the work.

## 1. Orient (read-only)

1. Read `TERMIGO.md`, then `AGENTS.md`.
2. Read `docs/README.md` and open only the architecture guides relevant to the audit scope.
3. Check `package.json` scripts, `docs/contributing/testing.md`, and `.github/workflows/ci.yml` for the canonical checks.

## 2. Evaluate structure

1. Confirm the two-process invariant: no OS access from `src/` except through allow-listed `invoke()` commands registered in `src-tauri/src/lib.rs` and `src-tauri/capabilities/default.json`.
2. Run `pnpm check:commands` to catch UI-referenced commands missing in Rust.
3. Confirm frontend conventions: `@/...` imports, forward-slash canonical paths with Windows boundary conversion, tabs kept mounted but hidden.
4. Confirm backend conventions: Unix-only logic behind `#[cfg(unix)]`, Windows arm in `pty::shell_init::windows`, terminal Enter sent as CR.

## 3. Evaluate quality bar

Score each area against `TERMIGO.md`: correctness (edge cases, concurrency), performance (bundle size, IPC round-trips, re-renders), security (deny-list on read and write, approval gating, keychain-only keys), UI/UX (every state handled), architecture (pure testable core, thin shell).

## 4. Run checks

```bash
pnpm lint
pnpm check-types
pnpm check:commands
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings
cd src-tauri && cargo nextest run --locked # fallback: cargo test --locked
```

Record each command, exit code, and failures verbatim. Do not fix unless asked.

## 5. Security pass

Inspect: secret-path deny-list (`src/modules/ai/lib/security.ts` and Rust side), shell allowlist and argument sanitization (`src-tauri/src/modules/shell/mod.rs`), workspace authorization allow and deny paths, IPC and capability allowlist, SSRF guard on fetch and web search, AI tool approval tiers, keychain handling. Never open `.env*`, `.ssh/`, or keychain contents.

## 6. Report

Group by severity (Critical, High, Medium, Low). Each finding needs: file and line, what happens, proof or reproduction, suggested fix, and which quality-bar item it violates. Format reference: `AUDIT-REPORT.md`. Security findings follow `SECURITY.md`.
