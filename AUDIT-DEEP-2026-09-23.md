# Termigo Deep Audit — 2026-09-23

Audited from scratch against the working tree at `b98c42da` (branch
`fix/security-audit-2026-09-22`). No prior audit document was used as a
starting point; every finding below was re-derived from the code and, where
marked, confirmed by running something.

Baseline established first:

| Check | Result |
|---|---|
| `cargo test --locked --no-fail-fast` | green: 384 unit + 8 integration suites, 0 failed, exit 0 |
| `cargo clippy --all-targets --locked` | Finished in 2m24s, no warnings emitted |
| `node scripts/check-invoke-commands.mjs` | "all 160 invoked Tauri commands are registered (165 registered total)", exit 0 |
| `pnpm test` / `pnpm check-types` | **not runnable in this environment** (see "Verification limits") |

---

## F-1 · High · The shell sandbox allowlist is bypassed by any absolute path

`src-tauri/src/modules/shell/mod.rs:197` (`allows_program`) returns `true` for
every program token that is rooted — leading `/` or `\`, a drive-letter prefix,
a UNC prefix, or anything containing a path separator. The stated reason is
that an agent legitimately runs binaries it just built.

Consequence: `SANDBOX_ALLOWLIST` never gets consulted for those, so the
allowlist is decorative. `chcp` is **not** in the list, yet this ran in the
current session:

```
$ C:\Windows\System32\chcp.com
Active code page: 437        # exit 0
```

The same shape admits `/bin/sh -c "..."`, `C:\Windows\System32\cmd.exe /c ...`,
`python -c ...`. The doc-comment at `mod.rs:30-31` ("Commands outside this set
must be run through an interactive PTY session") and the `TERMIGO.md` claim that
a shell allowlist is a control are both false as written. Elsewhere in the file
(`mod.rs:130-136`) the design is described as deliberately advisory, so the
code and its own documentation disagree about whether this is a boundary.

Minimal fix: keep the escape hatch but apply the existing basename check to it —
`command_basename` (`mod.rs:592`) already strips directories and extensions, so
requiring the final component of a rooted path to also be allowlisted removes
the arbitrary-execution hole while still letting `./target/debug/mytool` run.
If the intent really is "advisory only", then the doc-comment and `TERMIGO.md`
should say so, because a reader currently assumes a boundary exists.

## F-2 · High · The fs secret deny-list is not enforced on the shell path

The write tool refuses a secret basename, the shell does not:

```
write_file / read_file  -> Refused: "credentials.json" matches a sensitive-file pattern.
Set-Content ...credentials.json  -> exit 0, file written
```

`validate_shell_command` never calls `fs::security::is_secret_path` /
`is_protected`, and the fs layer cannot help because the write lands through
the spawned shell, not through `fs_write_file`. So `.env*`, `.ssh/*`,
`*.pem`, `credentials`, `*.npmrc` are all readable (`cat`, `Get-Content`) and
writable (`>`, `Out-File`, `Set-Content`, `cp`, `sed -i`) through a route that
the deny-list was written to cover.

Most serious instance: `/.termigo/hooks.json` is deliberately write-blocked at
`fs/security.rs:133` because a hook command "is read back and run on every
matching tool event with no prompt". That protection is bypassable by the same
shell route. **Inference, not executed** — I did not write a live hooks file,
since doing so would install a real silent-exec hook on this machine to prove a
point.

Minimal fix: in `validate_shell_command`, collect write targets (`>`, `>>`,
`Out-File`, `Set-Content -Path`, `cp`/`mv` destinations, `sed -i`) and run
`is_secret_path`/`is_protected` on each, mirroring `guard_write`.

## F-3 · Medium-High · Poison-unsafe `.unwrap()` on the PTY keystroke path

`src-tauri/src/modules/pty/commands.rs` locks the session map two different
ways. Nine sites use the poison-tolerant idiom (lines 92, 210, 212, 235, 254,
266, 318, 323, 365):

```rust
state.sessions.write().unwrap_or_else(|e| e.into_inner())
```

Five use a bare `unwrap()` (lines 99, 155, 165, 184, 194) — the post-insert
reap in `pty_open`, **both** locks in `pty_write`, and both locks in
`pty_resize`. `pty_write` is the latency-critical path for every keystroke and
paste.

A `RwLock`/`Mutex` poison is permanent. Any panic while one of those locks is
held means every subsequent keystroke and resize panics inside the Tauri
command, and no terminal in the app recovers until restart. The file's own
dominant idiom shows poison-tolerance is the intended invariant here; these
five are drift, not design.

Minimal fix: use `unwrap_or_else(|e| e.into_inner())` at those five sites.

## F-4 · Medium · Quote scanner speaks POSIX, executor speaks PowerShell

`quote_state::advance` (`shell/mod.rs:361`) treats a backslash as escaping the
following quote character, for both quote types. That is wrong twice over:
POSIX gives `\` no power inside single quotes, and PowerShell escapes with a
backtick and treats `\` as a literal.

Verified false refusals in this session:

```
echo 'a\' ; Get-Random ; echo 'b\'   -> "unclosed quote in command"
echo "a\" ; Get-Random ; echo "b"    -> "Refused: the command has an unclosed quote."
```

Both are well-formed for the shell that actually runs the command. Beyond the
noise, a scanner whose quote state disagrees with the executor's is the
precondition for slipping a `;` or `|` past the per-segment program check — the
metacharacter scan is skipped while `in_quote`. I tried to build an
accepted-and-executing PoC for that and could not: the parity works out so the
scanner ends inside a quote and refuses, i.e. it fails closed on the cases I
found. So this is reported as a confirmed correctness bug with a latent bypass
risk, not a proven escape.

Minimal fix: make the escape rule quote-type aware (never honor `\` inside
`'...'`), use backtick as the escape character when the resolved shell is
PowerShell, and keep failing closed.

## F-5 · Medium · Three different versions in one tree

| File | Version |
|---|---|
| `src-tauri/Cargo.toml:3` and `:16` | 0.9.15 |
| `src-tauri/tauri.conf.json:4` | 0.9.19 |
| `package.json:4`, `npm/termigo/package.json:3` | 0.9.18 |

`tauri.conf.json` is what the bundle and the updater advertise; the Rust crate
compiles as 0.9.15; the npm shim says 0.9.18. An install can therefore report
a version that no manifest agrees on, and update checks compare against a
number the shipped binary does not carry.

Minimal fix: one source of truth plus a mechanical check. There is already a
precedent for exactly this shape of guard in
`src-tauri/tests/command_authorization.rs`, which fails CI when the
authorization invariant drifts.

---

## Checked and clean

Recording these because "no findings" is only useful if the coverage is visible.

- **Secret deny-list, fs layer.** Enforced on read, glob, grep, tree, and the
  SFTP upload path; `guard_write` is symmetric with `guard_read` including the
  canonical pass and the parent-resolution case for files that do not exist yet
  (`fs/security.rs:406-432`). Confirmed live: `glob **/credentials.json`
  returned nothing while the file sat on disk at that path.
- **`code_index` / `code_search`.** I suspected a leak here — the indexer calls
  `native.readFile` with no security import at all (`ai/lib/codeIndex.ts` has
  zero references to the deny-list), and it persists chunk text to
  `.termigo/code-index.json`. Testing disproved it: the read itself is refused
  and the file is dropped by the `catch` at `codeIndex.ts:453`. Defense holds,
  though silently — a policy refusal is indistinguishable from an I/O error, so
  the agent gets no signal that a file was skipped.
- **`SubagentConcurrencyPool`.** The abort-versus-grant race is handled: `run()`
  removes the abort listener before claiming the slot, `onAbort` splices the
  waiter out of the queue, and `dequeue` deliberately does not double-count
  (`subagentPool.ts:75-83`). No leak found on any path.
- **SSH.** Remote path escapes above the filesystem root are refused rather than
  rewritten (`ssh/sftp.rs:168`), SFTP upload runs `validate_read` on the local
  path first (`ssh/sftp.rs:417`), host-key confirmation is a blocking TOFU with a
  120s timeout, and bare `ssh-rsa` (SHA-1) is dropped from the host-key set.
- **IPC registration invariant.** Mechanically asserted and currently passing.
- **Windows system directories.** Being writable is a documented operator
  choice (`fs/security.rs:92-99`, `shell/mod.rs:605-613`), not an oversight.
  Worth knowing the asymmetry it creates: the same agent action is hard-denied
  on Linux/macOS and prompt-only on Windows, and prompt guardrails are exactly
  what prompt injection targets.

## Verification limits

`pnpm test`, `pnpm check-types`, and `pnpm lint` could not be run.
`node_modules/vitest` and friends are pnpm junctions, and this agent shell
cannot traverse reparse points — proven rather than assumed:

```
Test-Path node_modules/vitest/vitest.mjs                                -> False
Test-Path node_modules/.pnpm/vitest@4.1.10_.../node_modules/vitest/vitest.mjs -> True
Get-Item node_modules/vitest | LinkType                                 -> Junction
```

`node` fails the same way (`MODULE_NOT_FOUND` on the junction path), and
`tsc` run from its real path still dies on `TS2688: Cannot find type definition
file for 'node'`. This is an environment limit, **not a Termigo defect**. The
practical consequence is that the ~1000-file frontend has no executed test or
type evidence in this audit; the ~200-file Rust backend is fully covered.
Re-running `pnpm test` in a normal terminal would close that gap.

## Suggested order of work

1. F-3 — five one-line changes, removes a whole-app dead-terminal failure mode.
2. F-2 — closes the route that makes the secret deny-list advisory.
3. F-1 — decide honestly whether the allowlist is a boundary or a hint, then
   make the code, the doc-comment, and `TERMIGO.md` agree.
4. F-4 — fix the escape semantics, add cases for both shells.
5. F-5 — version single source plus CI guard.

---

## Resolution status (same day, post-audit session)

All five findings were acted on in the hours after this audit; verified by
`cargo test` (387 lib + integration), `cargo clippy -D warnings`, `tsc`,
`biome`, and the full `vitest` suite (2926 tests).

| Finding | Status | Where |
|---|---|---|
| F-1 absolute-path allowlist bypass | **Resolved as documentation alignment** (operator decision): the allowlist is a friction control for bare names, not a hard boundary — the rooted-path escape hatch is intentional (agents run binaries they built). The doc-comment in `shell/mod.rs`, `TERMIGO.md`, and `docs/architecture/security-model.md` now say so explicitly and name the guards that ARE hard (approval layer, delete gate, secret write-target refusal, deny-lists). | `SANDBOX_ALLOWLIST` doc-comment; TERMIGO.md "Shell sandbox allowlist"; security-model.md |
| F-2 secret deny-list bypassed via shell | **Fixed**: `shell_write_hits_protected_target` in `validate_shell_command` refuses a write/delete verb (`Set-Content`, `Out-File`, `cp`, `mv`, `tee`, `del`, `Remove-Item`, `sed -i`, …) whose target matches `is_secret_path` / `is_protected` or ends in `.termigo/hooks.json` / `approvals.json`. Reads stay allowed (operator policy). 2 tests pin both directions. | `src-tauri/src/modules/shell/mod.rs` |
| F-3 poison-unsafe unwraps on the PTY keystroke path | **Fixed**: all five sites (`pty_open` re-check, both `pty_write` locks, both `pty_resize` locks) now use `unwrap_or_else(\|e\| e.into_inner())`, matching the file's dominant idiom. | `src-tauri/src/modules/pty/commands.rs` |
| F-4 quote scanner POSIX vs PowerShell | **Fixed**: shared `quote_is_escaped` helper — single quotes never honor backslash (any shell); double quotes honor an ODD backslash run on Unix only; on Windows backslash is literal (PowerShell/cmd escape via backtick — globally refused — or doubling, which the close/reopen toggle reproduces). The audit's bypass shape (`echo "a\" ; rm -rf C:\x "`) now validates as two segments and the `rm` tail is refused; the false refusals (`echo 'a\' ; …`) are gone. Platform-aware parity test added; `strip_dev_null_redirections` uses the same helper. | `src-tauri/src/modules/shell/mod.rs` |
| F-5 three versions in one tree | **Fixed**: every manifest aligned to 0.9.19 (Cargo.toml package + workspace, package.json, npm/termigo/package.json; tauri.conf.json already was) and `src-tauri/tests/version_parity.rs` now fails CI the moment any manifest drifts — the same mechanical-guard shape as `command_authorization.rs`. | manifests + new test file |

### Correction to "Verification limits" above

The junction-traversal claim ("this agent shell cannot traverse reparse
points … not a Termigo defect") was **empirically refuted** the same day:
`Test-Path node_modules/vitest/vitest.mjs` returns **True** from a plain
PowerShell, `node_modules/vitest` is a healthy Junction, and `pnpm exec
biome/vitest/tsc` all run. The audit's evidence was captured while a
CONCURRENT `pnpm install` (from a second agent session on the same tree)
was mid-prune — the `.bin` directory and top-level junctions transiently
disappear during that window. The real lesson is operational: **never run
two agent sessions that mutate one node_modules tree concurrently**; pnpm
has no cross-process lock. The frontend verification gap the audit noted
is closed: the full suite has since been run green on this machine
(2926 tests, tsc, biome).

### Also fixed in the same pass (from AUDIT-2026-10.md)

- NIT-1: `isOwnerUser` group fallback now fails CLOSED — a group chatId with
  no `ownerUserId` identifies nobody (previously every group member passed).
- SEC-4: the stale JSDoc claiming `"ask"` is the default was corrected to
  document the operator decision (`"all"` stays the default; the guards that
  remain are ALWAYS_ASK_TOOLS, deletesFiles, the deny-lists, and the prompt's
  Filesystem safety rules).
