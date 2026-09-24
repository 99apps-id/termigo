# Two-process model and IPC command reference

This guide elaborates on `TERMIGO.md`. If anything here conflicts with `TERMIGO.md`, `TERMIGO.md` wins.

## The split

Termigo is two processes: the Rust backend (`src-tauri/`) and the webview frontend (`src/`).

- **Rust owns all OS access**: PTY, file system, git, shell spawn, network, secrets, workspace authorization.
- **The webview never touches the FS, processes, or shells directly**. Every host operation goes through an `invoke()` call to a command registered in `src-tauri/src/lib.rs`.

This boundary is the root of the security model. Untrusted input (terminal escape sequences, file content, AI tool results) is parsed and validated in Rust or in carefully scoped frontend code, never executed by the renderer.

## Adding a new IPC command

1. Write the `#[tauri::command]` async function in the appropriate `src-tauri/src/modules/<area>/` module.
2. Register it in `src-tauri/src/lib.rs` inside the `tauri::generate_handler![...]` block.
3. If the command uses a Tauri plugin API (window, clipboard, dialog, etc.), add the plugin permission to `src-tauri/capabilities/default.json`.
4. Add a typed frontend wrapper in the matching `src/modules/<area>/lib/` directory and call it through Tauri's `invoke()` API.
5. If the command touches the file system, network, or shell, it must go through the existing guards (`security.ts` deny-list, workspace authorization registry, SSRF guard, AI tool approval).

Custom commands do not need to be listed one-by-one in `default.json`; the capability covers the window. Plugin permissions do.

## Command catalog

The commands registered in `src-tauri/src/lib.rs` are grouped below by module. Names are the Rust function names as seen by the frontend; the single source of truth is the `generate_handler!` block in `src-tauri/src/lib.rs`, which is a flat list, so the module headings here are a reading aid and not a Rust module boundary.

### PTY (`src-tauri/src/modules/pty/`)

Long-lived interactive terminal sessions.

- `pty_open` - create a new PTY session
- `pty_write` - send input bytes (text or control sequences)
- `pty_resize` - resize the PTY
- `pty_close` / `pty_close_all` - destroy one or all sessions
- `pty_has_foreground_process` / `pty_has_foreground_job` - detect whether a command is running
- `pty_shell_name` / `pty_list_shells` - shell detection and enumeration
- `pty_persist_available` - whether shell-init persistence works in this environment
- `pty_ack_output` - releases output credit for a session at a cumulative byte mark the frontend reports it has consumed. This is the back-pressure on streaming output: the mark is monotonic, so a repeated or overtaken ack is a no-op rather than an error, and an ack for an unknown session is also a no-op because the session may have closed in between

Output streams from `pty_open` via a Tauri `Channel<PtyEvent>`.

### File system (`src-tauri/src/modules/fs/`)

#### Tree

- `list_subdirs` - list subdirectories
- `fs_read_dir` - read a directory

#### File

- `fs_read_file` - read file contents
- `fs_read_file_base64` - read file contents as base64, for bytes that are not valid UTF-8
- `fs_read_image_base64` - read an image for the vision path
- `fs_write_file` - write file contents
- `fs_write_file_base64` - write file contents from base64
- `fs_stat` - file metadata
- `fs_canonicalize` - canonical path

#### Mutate

- `fs_create_file` / `fs_create_dir`
- `fs_rename` / `fs_delete` / `fs_copy`

#### Watch

- `fs_watch_add` / `fs_watch_remove` - filesystem change notifications

#### Search

- `fs_search` - fuzzy file finder
- `fs_list_files` - recursive file listing

#### Grep

- `fs_grep` - content search
- `fs_grep_interactive` - interactive content search
- `fs_glob` - glob matching

**Async note.** `fs_search`, `fs_grep`, `fs_glob`, `fs_read_dir` and `list_subdirs` are `#[tauri::command] async fn` that run their tree walk on `tauri::async_runtime::spawn_blocking`, so a large repo never blocks the UI thread. `fs_list_files` is synchronous.

### Git (`src-tauri/src/modules/git/`)

All git commands are gated through the workspace authorization registry.

- `git_resolve_repo` / `git_panel_snapshot`
- `git_status`
- `git_diff` / `git_diff_content`
- `git_stage` / `git_unstage` / `git_discard`
- `git_commit`
- `git_fetch` / `git_pull_ff_only` / `git_push`
- `git_log` / `git_show_commit` / `git_commit_files` / `git_commit_file_diff`
- `git_remote_url`
- `git_list_branches` / `git_checkout_branch`
- `git_diff_comments_add` / `git_diff_comments_list` / `git_diff_comments_list_for_file` / `git_diff_comments_update` / `git_diff_comments_remove` - review annotations attached to a diff

### Shell (`src-tauri/src/modules/shell/`)

Three distinct surfaces:

- `shell_run_command` - one-shot subshell exec for AI tools
- `shell_session_open` / `shell_session_run` / `shell_session_interrupt` / `shell_session_close` - persistent agent shell with state across calls
- `shell_bg_spawn` / `shell_bg_logs` / `shell_bg_kill` / `shell_bg_list` - long-running background processes with bounded ring-buffer log capture; `shell_bg_spawn` accepts an optional `log_path` to ALSO append the full output to a file, so a run that overflows the ring (reported as `dropped`) still keeps every line of evidence (the path is surfaced via `log_path` on logs/list)

### Shell REPL (`src-tauri/src/modules/shell/repl.rs`)

A third shell surface, between `shell_run_command` and `shell_bg_*`. An interactive tool that never exits (a debugger such as `pdb`, `dlv`, `gdb`, or a language REPL) cannot be run as a one-shot command because the call never returns, and `shell_bg_*` keeps a process alive but gives it no stdin because a daemon should not inherit one. A REPL is neither: write a line, read until the prompt returns, write the next one.

- `repl_open` - spawn a process with a live stdin pipe and an initial prompt to wait for
- `repl_send` - write a line and return the next turn (`ReplTurn`: output, whether the prompt matched, the next byte offset, and dropped bytes)
- `repl_close` - close stdin, which is how a REPL is asked to exit politely
- `repl_list` - enumerate live handles

Open sessions are reaped before the cap is enforced, so processes that already exited do not consume slots against sessions an agent forgot to stop.

### LSP host (`src-tauri/src/modules/lsp/`)

A process host, not a protocol implementation: Rust owns Content-Length framing and process lifecycle, the frontend owns the language-server intelligence. `lsp/framing.rs` is pure and tested.

- `lsp_host_pid` - pid of the hosting Termigo process, so the frontend can tell a live host from one that restarted
- `lsp_detect` - resolve a server binary to an absolute path through the captured login-shell env, which a GUI-launched app does not otherwise have
- `lsp_spawn` - start a server against an authorized workspace root with an optional RSS cap, streaming over two `Channel`s, and return its session id
- `lsp_resolve_root` - walk up from a path to the first project marker
- `lsp_send` - write one already-framed message to a session
- `lsp_kill` - take a session out of the registry and terminate it

The spawn cwd goes through the same workspace authorization registry as every other process-spawning command, and WSL workspaces are rejected rather than silently run on the host. Root detection stops at `$HOME`, because a stray `package.json` in the home directory would otherwise let a server index the whole home tree. Servers die with their host: their own process group on Unix, a Job Object on Windows, and every session is killed on `RunEvent::Exit`.

### Workspace (`src-tauri/src/modules/workspace.rs`)

- `workspace_authorize` / `workspace_current_dir` - the spawn/git/AI cwd authorization registry
- `wsl_list_distros` / `wsl_default_distro` / `wsl_home` - WSL bridge

### Network (`src-tauri/src/modules/net.rs`)

- `ai_http_request` / `ai_http_stream` - AI HTTP proxy with SSRF guard
- `lm_ping` - local-model ping
- `http_probe` - health-probe a local dev server. Loopback only (`localhost` / `127.0.0.1` / `::1`), no redirects, short bounded timeout; used to wait until a spawned server is listening before opening it in the preview pane

### Secrets (`src-tauri/src/modules/secrets.rs`)

- `secrets_get` / `secrets_set` / `secrets_delete` / `secrets_get_all` - OS keychain access, service `termigo-ai`

### Agent hooks (`src-tauri/src/modules/agent.rs`)

- `agent_enable_hooks` / `agent_hooks_status` - install/status terminal coding-agent hooks (Claude Code, Codex, Gemini CLI)
- `agent_locate_command` - resolve an executable the way a shell would, for hook install

### Remote: SSH and SFTP (`src-tauri/src/modules/ssh/`)

Mirrors the local PTY command shape (`ssh_open` / `ssh_write` / `ssh_resize` / `ssh_close`) so the frontend can swap a local PTY for a remote shell with minimal plumbing.

- `ssh_agent_keys` - list keys held by the local ssh-agent. Private keys stay inside the agent; Termigo only ever sees signatures.
- `ssh_open` / `ssh_write` / `ssh_resize` / `ssh_close` - remote shell session, output over a `Channel<SshEvent>`
- `ssh_exec` - non-interactive remote command, used by remote tool paths
- `ssh_forward_open` - local port forward
- `ssh_confirm_host_key` - answer a host-key prompt (`prompt_id`, accept)
- `ssh_list_sessions` / `ssh_attach` - enumerate and re-attach to live sessions
- `ssh_sftp_home` / `ssh_sftp_read_dir` / `ssh_sftp_read_file` / `ssh_sftp_write_file` / `ssh_sftp_upload` / `ssh_sftp_create_file` / `ssh_sftp_create_dir` / `ssh_sftp_rename` / `ssh_sftp_delete` - the remote explorer (`ssh/sftp.rs`)

**Host-key handling is trust-on-first-use, not trust-always.** The first connect to a new host reports its SHA-256 fingerprint and the frontend persists it as `lastFingerprint` on the connection. Every later connect passes that value as `expected_fingerprint`, and a mismatch aborts the handshake with a host-key-mismatch error rather than proceeding (`session::HostKeyVerifier`). A legitimately rotated key is re-trusted by clearing the saved fingerprint.

### History (`src-tauri/src/modules/history/`)

- `history_suggest` / `history_commands` / `history_record` / `history_list` - shell history integration

### Browser (`src-tauri/src/modules/browser.rs`)

Each browser instance is a dedicated Tauri webview window that the agent drives.

- `browser_open` / `browser_close` / `browser_list` - instance lifecycle
- `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` / `browser_url` - navigation
- `browser_wait` - wait for a condition before reading
- `browser_extract` / `browser_console` - read page text and console output
- `browser_screenshot` - capture the instance
- `browser_eval` - inject JS into the page
- `browser_embed_update` / `browser_embed_navigate` / `browser_embed_read` / `browser_embed_eval` / `browser_embed_screenshot` / `browser_embed_close` - the embedded preview surface

The frontend guards URLs through `browserGuard.ts`, and this module **re-applies the same host policy on the Rust side**, so a bypass in one layer cannot reach the network stack. Value-returning reads flow back through a `termigo:browser-value` Tauri event rather than IPC return values, because the injected script cannot always reach Tauri's sync invoke path.

### SQL (`src-tauri/src/modules/sql.rs`)

- `sql_run` - run a query against an engine chosen in Settings

Execution is delegated to an installed CLI (`sqlite3`, `duckdb`, `psql`, `mysql`, `mariadb`), and the engine name is checked against that fixed list so a typo cannot reach a shell. The query is piped over stdin, so it never appears in process argv and cannot be shell-escaped, and the connection string is passed as a single argument rather than through a shell, rejecting option-injection and control-byte tricks up front. Output is capped.

### System (`src-tauri/src/modules/system.rs`)

- `clipboard_get` / `clipboard_set` - clipboard text, via `arboard`
- `env_get` / `env_list` - process environment inspection

Environment access is **read-only by design**. The agent may inspect `PATH`, `HOME`, `TERM` and friends to answer questions, but mutating the parent process environment would be useless (child shells snapshot their own) and surprising.

### Backup (`src-tauri/src/modules/backup.rs`)

- `backup_seal` / `backup_open` - encrypt and decrypt an exported backup

An exported backup carries keychain-resident credentials (SSH passwords and private keys), so it is never written as plaintext: it ends up on a USB stick, in Downloads, or in a synced folder. Construction is PBKDF2-HMAC-SHA256 over the passphrase with a random 16-byte salt (600k iterations, recorded in the envelope rather than hardcoded so the cost can be raised), then AES-256-GCM with a random 12-byte nonce; GCM's authentication tag is what detects a wrong passphrase or a truncated file. `backup_open` rejects an unknown KDF name and caps the iteration count the envelope may request at 10x, because otherwise a hostile file could turn an unauthenticated open into hours of PBKDF2.

These two commands are the whole crypto surface; everything above them in JS only ever handles an already-sealed blob. They live in the host process because `crypto.subtle` is gated to secure contexts and the app origin is plain http.

### ChatGPT auth (`src-tauri/src/modules/chatgpt_auth.rs`)

- `chatgpt_auth_login` / `chatgpt_auth_refresh` - OAuth token acquisition and refresh for the ChatGPT provider path

### MCP (`src-tauri/src/modules/mcp.rs`)

- `mcp_list_servers` / `mcp_list_tools` / `mcp_call_tool` / `mcp_ping` - enumerate and invoke configured servers
- `mcp_add_server` / `mcp_remove_server` - server registry

### Extensions (`src-tauri/src/modules/extensions/`)

- `ext_list` / `ext_read_manifest` / `ext_read_asset` / `ext_read_asset_bytes` - discovery and asset loading
- `ext_install_from_zip` / `ext_install_from_github` / `ext_peek_zip` / `ext_peek_github` - install, with peek so a package can be inspected before it is trusted
- `ext_check_update` / `ext_enable` / `ext_disable` / `ext_uninstall` - lifecycle

Extensions live at `app_data_dir/extensions/<id>/` and are loaded by the frontend via `convertFileSrc` plus dynamic `import()`. Rust owns install, manifest parsing, and the persisted enable state; the frontend owns activation, the host API, and the contribution registries. Extraction rejects zip entries whose `enclosed_name()` escapes the destination root, asset reads canonicalize and re-anchor against the extension root, install size is capped, and HTTP downloads only follow `https://`.

### Settings window

- `get_launch_dir` - CLI launch directory, drained on first read
- `get_launch_files` - files passed on the command line, drained on first read
- `open_settings_window` - open the separate settings webview (optional `tab` deep-link)

### CLI control plane

- `control_frontend_ready` - marks the restored main UI ready for routed CLI actions
- `control_respond` - completes a pending UI-bound CLI request

See [CLI control plane](cli-control.md) for the local protocol and packaging model.

## Invariants

- The webview must not spawn processes, read files, or make network calls except through the commands above.
- New commands must be registered in `lib.rs` and guarded at the boundary (workspace auth, deny-list, SSRF, approval flow).
- Plugin permissions must be added to `src-tauri/capabilities/default.json` if the command uses a plugin API.

## See also

- [`TERMIGO.md`](../../TERMIGO.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [PTY shell integration](pty-shell-integration.md) - how sessions and shell integration work
- [Security model](security-model.md) - the boundaries every command must respect

## Implementation notes

Moved verbatim from `TERMIGO.md` when that file was trimmed to fit the 10 KB of project memory the agent is given. Checked before moving: 37 of the code identifiers below appeared nowhere else in this document, so this is detail, not a duplicate.

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (xterm ↔ portable-pty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams via a Tauri `Channel<PtyEvent>`.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_delete`): file explorer + editor IO.
- `fs::search::*` (`fs_search`, `fs_list_files`), `fs::grep::*` (`fs_grep`, `fs_glob`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates).
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`, `git_list_branches`, `git_checkout_branch`, `git_diff_comments_add` / `_list` / `_list_for_file` / `_update` / `_remove`). All gated through the workspace authorization registry.
- `shell::shell_run_command`: one-shot subshell exec used by AI tools. Distinct from PTY sessions; not the user's interactive terminal. On Windows via PowerShell (`-NoProfile -Command`), on Unix via `$SHELL -lc`. Shared helper `build_oneshot_command`.
- `shell::shell_session_*` (`open`, `run`, `interrupt`, `close`): persistent agent shell with state across calls. `shell::repl_*` (`open`, `send`, `close`, `list`, in `shell/repl.rs`): a live stdin pipe for interactive tools that never exit (debuggers, language REPLs), which neither a one-shot exec nor a stdin-less background process can serve. `shell::shell_bg_*` (`spawn`, `logs`, `kill`, `list`): long-running background processes (dev servers etc.) with bounded ring-buffer log capture.
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the spawn/git/AI cwd authorization registry) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`).
- `lsp::*` (`lsp_detect`, `lsp_host_pid`, `lsp_resolve_root`, `lsp_spawn`, `lsp_send`, `lsp_kill`): language server process host. Dumb JSON-RPC pipe: Content-Length framing + process lifecycle in Rust (`lsp/framing.rs`, pure + tested), protocol intelligence on the frontend. Spawn cwd gated through the workspace registry; binaries resolve via the captured login-shell env (`lsp/env.rs`, GUI apps get a bare PATH on macOS); root detection walks up to markers but never to or above `$HOME`. Servers run in their own process group on Unix and are group-killed (cargo check / proc-macro children die with the server); Windows children get a `proc::job::ProcessJob` (kill-on-close, shared with pty). All sessions killed on `RunEvent::Exit`.
- `net::*` (`ai_http_request`, `ai_http_stream`, `lm_ping`): AI HTTP proxy with SSRF guard; keeps provider calls and local-model pings off the webview. Bodies never cross as `number[]` (JSON writes that at 3.0x, re-paid on every agent step): a request body arrives as `RequestBody::Text` when it is already a string - which every AI call is - or `Base64` when binary, and response chunks go back base64 since a chunk boundary can split a UTF-8 sequence.
- `secrets::secrets_*`: OS keychain via the `keyring` crate. Service constant `termigo-ai`. Linux uses a file-based fallback gated behind `#[cfg(target_os = "linux")]`.
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section).
