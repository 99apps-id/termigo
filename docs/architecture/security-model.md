# Security model

This guide elaborates on `TERMIGO.md`. If anything here conflicts with `TERMIGO.md`, `TERMIGO.md` wins.

Termigo runs shells, reads and writes files, and sends data to AI providers. In this fork, AI agents and subagents operate in an open, unconstrained environment with no sandbox, no artificial path boundaries, and full access to available tools. The security architecture focuses on foundational OS-level guarantees, secure credential isolation, and Git worktree support.

## Core security principles

The main system boundaries and guarantees are:

1. **IPC boundary** - commands registered in `src-tauri/src/lib.rs`, gated by `src-tauri/capabilities/default.json`.
2. **Secret storage in OS keychain** - API keys and credentials live in the OS keychain via `secrets_*`, never stored in plaintext on disk or in `localStorage`.
3. **Network SSRF guard** - AI HTTP proxy in `src-tauri/src/modules/net.rs` prevents SSRF and DNS-rebinding attacks on cloud metadata.
4. **Git worktree support and isolation** - bidirectional verification for linked worktrees ensures subagents and branches operate with isolated checkouts.
5. **Terminal escape-sequence boundary** - OSC sequences are parsed and acted on safely, never blindly trusted to corrupt terminal state.

## Filesystem access and worktree integration

Unlike restrictive environments that jail AI agents into a single folder, Termigo provides unrestricted filesystem access across the host system. Agents and subagents can read, write, edit, and traverse files anywhere accessible to the user process.

`WorkspaceRegistry` (`src-tauri/src/modules/workspace.rs`) tracks workspace roots, PTY launch directories, and Git worktrees:

- `workspace_authorize` registers active workspace directories.
- `authorize_spawn_cwd` accepts accessible directories and automatically resolves linked Git worktrees without boundary errors.
- `authorize_user_spawn_cwd` registers the user's chosen cwd as an active root.
- **Git worktree authorization**: `is_git_worktree_of_authorized` performs bidirectional verification for linked worktrees (verifying `.git` gitdir link and `<gitdir>/gitdir` backlink to an authorized parent repo). Valid worktrees under `.termigo/worktrees/` or custom worktree locations are authorized automatically for shell execution and git operations (`panel_snapshot`, `list_branches`) without manual prompts.
- Filesystem commands (`fs::*`) execute operations across projects without artificial workspace boundary rejections.

Outside `fs::*`, the same boundary applies to every command that names a local path:

- `sql_run` gates a local database file (`sqlite3` / `duckdb` connection) with the deny-list plus `require_authorized` before spawning the client. A URL or a bare database name is server-resolved and needs no filesystem gate.
- `ssh_sftp_upload` runs the local source path through the deny-list. The workspace registry is deliberately not applied - uploading a file from outside the open project is legitimate - but a secret path cannot be read and shipped to a remote host.
- `ext_peek_zip` / `ext_install_from_zip` run the chosen package path through the deny-list.
- `ext_read_asset` / `ext_read_asset_bytes` are confined to the extension's own sandbox directory by `resolve_asset`, which refuses `..` and absolute relative paths.
- Git commands delegate every repo path to `git::operations`, which consults the registry.

### Enforcement

The rule above is checked mechanically, not by review:
`src-tauri/tests/command_authorization.rs` parses the registered command
catalogue out of `lib.rs`, finds every command that takes a path-like
parameter, and fails when the implementing module calls neither an
authorization helper nor the deny-list. Commands that legitimately need
neither are listed there with a written reason, and a second test fails if an
allow-listed command is renamed or removed, so the list cannot rot.

That test exists because the invariant previously lived only in prose: 20 of
21 `fs::*` commands had no registry check while this document claimed they
did, and `sql_run` was missed by the audit that fixed them.

## Shell command execution and worktree integration

Shell command execution from agent tools (`bash_run`, `bash_background`, `run_checks`, custom tools) operates without sandbox allowlist restrictions:

- **Unrestricted shell execution**: `validate_shell_command` (`src-tauri/src/modules/shell/mod.rs`) allows all non-empty commands directly. Agents are not confined by command allowlists and can run arbitrary compilers, package managers, test runners, and system utilities.
- **PATH for project tooling**: The spawned shell's PATH is prepended with the `node_modules/.bin` chain from the cwd upward (npm-run semantics), so `biome`, `vitest`, `tsc`, etc. resolve by bare name. On Windows, the shell executes with `-ExecutionPolicy Bypass` so PowerShell `.ps1` shims execute cleanly without script restriction errors. Package-manager mutations get a 300s timeout floor to avoid corrupted states.
- **Git worktree support**: Shell commands and background tasks seamlessly execute inside Git worktrees (`.termigo/worktrees/` or custom worktrees), providing isolated workspaces for subagents and parallel branches.
- **Command risk classification (`commandRisk.ts`)**: Read-only lint, verification, and audit subcommands are classified as introspection (`read_only`). Active test execution (`vitest run`, `cargo test`, `pytest`, `go test`) is classified as `change`.
- **Instruction guidelines**: Agent behavior is guided pragmatically by `USER.md`, `AGENTS.md`, and `TERMIGO.md`.

## AI tool approval flow

In `src/modules/ai/tools/tools.ts`:

- Read-only tools (`read_file`, `list_directory`, `grep`, `glob`) auto-execute after passing the deny-list.
- Mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`, `move_file`, `copy_file`, `delete_file`, `replace_in_files`, `bash_run`, `bash_background`) set `needsApproval: true`. The AI SDK pauses and surfaces a `tool-approval-request` part rendered as a confirmation card.
- `edit` / `multi_edit` enforce a read-before-edit invariant: the model must have read the file earlier in the session.

Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`, and the approval must be the last message when the request goes out or `streamText` never executes the call. See [AI subsystem](ai-subsystem.md#approval-resume-nothing-may-follow-the-approval).

### Deleting is never delegated

`isAutoApproved` (`src/modules/ai/lib/approvalPolicy.ts`) checks a floor before
every other branch, including the `all` shortcut and the remote-command path:

- `delete_file` always asks, in every mode.
- So does any tool carrying a `command` that `deletesFiles`
  (`src/modules/ai/lib/commandRisk.ts`) recognises - `rm`, `rmdir`, `unlink`,
  `shred`, `git clean`, `find -delete` / `-exec`, and the Windows and
  PowerShell spellings (`del`, `erase`, `rd`, `Remove-Item`, `ri`). The
  classifier reads each `&&` / `;` / `|` segment, so `pnpm build && rm -rf dist`
  is not read as a build, and scans whole lines containing a substitution,
  where a first-word read cannot see the verb.

The gate follows the command rather than the tool name, so a custom tool
cannot route around it by not being called `bash_run`. The reasoning is the
asymmetry: every other change is recoverable by re-reading the file or from
git, while a delete of something untracked leaves nothing to read.

### Unfinished tool calls

Before the history reaches the model, `src/modules/ai/lib/sanitizeMessages.ts`
resolves every tool call that never produced a result. Without this, an
OpenAI-compatible provider rejects the whole request - "An assistant message
with 'tool_calls' must be followed by tool messages responding to each
'tool_call_id'" - and the session stays broken for every later message, not
just the one that was interrupted.

Such a call is marked interrupted rather than deleted. Deleting it satisfies
the provider but rewrites history: the model is shown a past in which it never
made the call, cannot tell its work was cut short, and tends to repeat it.
`input-streaming` is the one exception and is still dropped, because its
arguments were half-transmitted and there is no complete call to resolve.

`approval-responded` is the subtle case. While a run is being continued the
user has answered and the SDK is about to execute the call, so it must be left
alone; once the conversation has moved past that turn nothing will ever execute
it. The two are told apart by position - the part is preserved only when it
sits in the final message and that message is the assistant turn being
continued.

## SSH & SFTP security

The SSH module (`src-tauri/src/modules/ssh/`) follows the same local-first
rules:

- **Credentials never touch disk in plaintext.** Passwords, private keys and
  key passphrases go to the OS keychain via `secrets_*`; the connection
  store keeps only flags marking which secrets exist.
- **ssh-agent auth** is preferred: the private key stays inside the agent and
  only signatures cross the wire.
- **Host-key verification (TOFU).** The first connect to a host pauses the
  handshake before any credential is sent and shows the `SHA256:` fingerprint;
  accepting pins it on the saved connection. A later connect that sees a
  different key aborts with a host-key-mismatch error (MITM protection).
  Pinning uses the vetted host-key algorithm set (ed25519 / ecdsa / rsa-sha2);
  bare `ssh-rsa` (SHA-1) is refused.
- **SFTP operations run as the remote SSH user** - the remote kernel enforces
  permissions, and `permission denied` bubbles up into the explorer tree.
- **Upload path safety** mirrors the local drop rules: only absolute local
  paths the user explicitly dragged are uploaded.

## SSRF and DNS rebinding defense

`src-tauri/src/modules/net.rs` proxies AI provider requests and local-model pings. Before connecting:

1. Resolve the hostname once (`resolve_and_classify`).
2. Classify every resolved IP as public, private, loopback, or blocked metadata.
3. Block cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, AWS IPv6 metadata, etc.).
4. Pin reqwest to the resolved IPs so a second DNS lookup cannot return a different address (DNS rebinding).

Local LLM endpoints are explicitly allowed because the user opted in by pointing Termigo at them, but they are still classified and logged.

## Secret storage

API keys are stored via `secrets_*` commands (`src-tauri/src/modules/secrets.rs`):

- macOS: Keychain via `keyring`
- Windows: Credential Manager via `keyring`
- Linux: a JSON file in the app's local data dir with mode `0600` (atomic write to `.tmp` then rename)

Service constant: `termigo-ai`. Keys never touch disk outside the keychain/Linux secrets file, never go in `localStorage`, and never appear in logs.

## OSC trust gating

The terminal parses OSC sequences from the PTY byte stream:

- **OSC 7** updates the tab cwd.
- **OSC 133 A/B/C/D** marks prompt/command boundaries.
- **OSC 777** is used by the agent detector to signal coding-agent state transitions.

The agent detector (`src-tauri/src/modules/pty/agent_detect.rs`) is armed by `OSC 133;C;<cmd>` or by a self-armed marker and emits `termigo:agent-signal` events. It is driven **only by OSC sequences**, never by raw output, so a repainting TUI never flaps.

## Invariants

- AI agents and subagents operate without sandbox or path boundary limitations; all tools are available.
- Standard project instructions are governed by `USER.md`, `AGENTS.md`, and `TERMIGO.md`.
- Git worktree resolution and isolation are maintained across backend and frontend.
- New network-facing commands must go through the `net.rs` proxy or reimplement the same classification and DNS pinning.
- New plugin APIs must be added to `src-tauri/capabilities/default.json`.
- Keys, tokens, and credentials stay in the OS keychain / Linux secrets file.

## See also

- [`TERMIGO.md`](../../TERMIGO.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [AI subsystem](ai-subsystem.md) - tools, approval flow, and provider handling
