# Security model

This guide elaborates on `TERMIGO.md`. If anything here conflicts with `TERMIGO.md`, `TERMIGO.md` wins.

Termigo runs shells, reads and writes files, and sends data to AI providers. The security model is defense-in-depth: no single guard is enough, so every boundary validates input before acting on it.

## Boundaries

The main trust boundaries are:

1. **IPC boundary** - commands registered in `src-tauri/src/lib.rs`, gated by `src-tauri/capabilities/default.json`.
2. **File-system boundary** - AI tools go through `src/modules/ai/lib/security.ts`; PTY spawn goes through the workspace authorization registry.
3. **Network boundary** - AI HTTP proxy in `src-tauri/src/modules/net.rs` with SSRF and DNS-rebinding defenses.
4. **Secret-storage boundary** - keys live in the OS keychain, never on disk or in `localStorage`.
5. **Terminal escape-sequence boundary** - OSC sequences are parsed and acted on, but never blindly trusted to mutate state.

## Secret-path deny-list

`src/modules/ai/lib/security.ts` refuses reads and writes of obvious secret paths. This applies **on both read and write** and must never be bypassed.

Blocked categories include:

- Files: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `known_hosts`, `credentials`, `service-account*.json`, and similar.
- Directories: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.config/gh`, `~/.git`, system dirs (`/etc`, `/proc`, `/sys`), and Windows credential stores.
- System write prefixes: `/etc/`, `/var/db/`, `/usr/bin/`, `/windows/`, `/program files/`, etc.

The comparison surface normalizes paths: backslashes to forward slashes, strips Windows drive letters, strips NTFS alternate data streams, strips trailing dots/spaces, lowercases, and collapses duplicate slashes. Protected directories are matched as exact path or descendant, not raw substring.

`checkReadableCanonical` and `checkWritableCanonical` also canonicalize the path and re-check the resolved form so a symlink at an innocent path pointing into `~/.ssh` is caught.

## Workspace authorization registry

`WorkspaceRegistry` (`src-tauri/src/modules/workspace.rs:20`) tracks directories that PTY spawn, git commands, and AI tools are allowed to operate in.

- `workspace_authorize` adds a directory.
- `authorize_spawn_cwd` rejects a spawn cwd outside an authorized root.
- `authorize_user_spawn_cwd` registers the user's chosen cwd as a new root instead of rejecting it.
- The registry is bootstrapped with the launch directory and the user's home directory (`workspace.rs:135`).

This is the allow side of the file-system boundary. Any new feature that spawns a shell or mutates files outside the current workspace must interact with this registry.

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
  (`src/modules/ai/lib/commandRisk.ts`) recognises — `rm`, `rmdir`, `unlink`,
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
OpenAI-compatible provider rejects the whole request — "An assistant message
with 'tool_calls' must be followed by tool messages responding to each
'tool_call_id'" — and the session stays broken for every later message, not
just the one that was interrupted.

Such a call is marked interrupted rather than deleted. Deleting it satisfies
the provider but rewrites history: the model is shown a past in which it never
made the call, cannot tell its work was cut short, and tends to repeat it.
`input-streaming` is the one exception and is still dropped, because its
arguments were half-transmitted and there is no complete call to resolve.

`approval-responded` is the subtle case. While a run is being continued the
user has answered and the SDK is about to execute the call, so it must be left
alone; once the conversation has moved past that turn nothing will ever execute
it. The two are told apart by position — the part is preserved only when it
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
- **SFTP operations run as the remote SSH user** — the remote kernel enforces
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

- The deny-list in `security.ts` applies on both read and write. Never bypass it.
- New file-system-touching commands must respect the workspace authorization registry.
- New network-facing commands must go through the `net.rs` proxy or reimplement the same classification and DNS pinning.
- New plugin APIs must be added to `src-tauri/capabilities/default.json`.
- Keys, tokens, and credentials stay in the keychain / Linux secrets file.

## See also

- [`TERMIGO.md`](../../TERMIGO.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [AI subsystem](ai-subsystem.md) - tools, approval flow, and provider handling
