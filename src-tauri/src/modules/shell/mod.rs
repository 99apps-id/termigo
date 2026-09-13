pub mod background;
pub mod ringbuffer;
pub mod session;

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, RwLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use shared_child::SharedChild;

#[cfg(windows)]
use crate::modules::workspace::validate_wsl_distro_name;
use crate::modules::workspace::{authorize_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};

use background::{BackgroundLogResponse, BackgroundProc, BackgroundProcInfo};
use session::{SessionRunOutput, ShellSession};

// 30s was too short: a project-wide lint/test/build (`eslint .`, `pnpm test`,
// `cargo build`) easily exceeds it and times out, so the agent re-runs it. 120s
// covers a normal one; pass `timeout_secs` (up to 300) for a genuinely slow job.
const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// Allowlisted read-only / inspection commands for agent-triggered execution.
/// Commands outside this set must be run through an interactive PTY session.
const SANDBOX_ALLOWLIST: &[&str] = &[
    "cat", "head", "tail", "wc", "grep", "rg", "sed", "awk",
    "find", "ls", "stat", "file", "xxd", "hexdump", "od",
    "git", "npm", "pnpm", "yarn", "cargo", "go", "python", "python3",
    "node", "deno", "bun", "make", "just", "task",
    "echo", "printf", "test", "true", "false", "pwd", "cd",
    "which", "where", "type", "command", "hash",
    "diff", "cmp", "comm", "patch", "jq", "yq",
    "tar", "gzip", "gunzip", "zip", "unzip",
    "curl", "wget", "http", "xh",
    "date", "uptime", "whoami", "id", "uname", "hostname",
    // Pentest & network recon tooling supported by Termigo
    "nmap", "masscan", "rustscan", "nikto", "nuclei", "httpx", "wpscan",
    "sqlmap", "ffuf", "gobuster", "dirsearch", "subfinder",
    //
    // Project toolchains. An agent that cannot run the project's own checks
    // cannot verify its work, and these are the binaries a repository's scripts
    // invoke. `pnpm lint` worked (the base command is `pnpm`) while `biome`,
    // `tsc` and `vitest` did not, so the moment a caller wanted one file
    // (`biome lint src/x.ts`, `vitest run src/x.test.ts`) or a raw flag it hit
    // "not in the agent allowlist" and had to route through a PTY for a
    // read-only check.
    //
    // This does not widen the trust boundary: `node`, `python`, `bun`, `deno`
    // and `pnpm` are already allowed, and each of them can execute arbitrary
    // code. A linter, a type checker and a test runner are strictly less
    // powerful than the interpreters beside them, so the boundary is unchanged
    // while the friction is gone.
    //
    // JS/TS (`biome`, `tsc`, `vitest`, `knip`, `vite` are this repo's own)
    "biome", "tsc", "vitest", "knip", "vite", "eslint", "prettier",
    "jest", "mocha", "playwright", "size-limit",
    // Python
    "ruff", "black", "mypy", "pytest", "flake8", "isort",
    // Go / Rust helpers whose base command is not `go`/`cargo`
    "golangci-lint", "rustfmt", "clippy-driver",
    //
    // Document generators. An agent asked for a report in a format the user can
    // open in Word/Excel/PowerPoint has to be able to produce one, and
    // `officecli` is the single self-contained binary that writes
    // .docx/.xlsx/.pptx with no Office install. It belongs here for the same
    // reason `tar` and `zip` do: it writes the file it was asked to write and
    // launches nothing else, so it is not a wider trust boundary than the
    // package managers already listed above it. Without this entry only a
    // machine-specific absolute path worked, because `allows_program` accepts
    // rooted paths, so the same instruction behaved differently per host.
    "officecli",
    //
    // Read-only text and path utilities, added so a pipeline is actually
    // usable. Allowing `|` (below) removed the refusal but not the friction on
    // its own: `ls | sort | uniq` and `git log | cut -f1` still failed because
    // the filter side was unlisted. The rule for this group is that a program
    // here can neither write to the filesystem nor launch another program:
    // that excludes `xargs`, `env`, `timeout`, `nice`, `nohup`, `watch`, `tee`
    // and the shells, each of which would let an unlisted program run behind a
    // listed name.
    "sort", "uniq", "cut", "tr", "nl", "paste", "join", "fold", "rev",
    "basename", "dirname", "realpath", "readlink", "seq", "expr",
    "sha256sum", "sha1sum", "md5sum", "base64", "strings", "du", "df",
];

/// Whether a program token may run without a PTY.
///
/// An absolute or rooted path is always allowed, on Unix (`/...`) and Windows
/// (`C:\...`, `\...`), because the agent legitimately runs binaries it built.
/// Anything else has to match the allowlist by base name, with the Windows
/// shim extensions (`.exe`, `.cmd`, `.bat`) stripped first.
fn allows_program(program: &str) -> bool {
    let path = std::path::Path::new(program);
    let is_windows_drive_path = program.len() >= 3
        && program.as_bytes()[0].is_ascii_alphabetic()
        && program.as_bytes()[1] == b':'
        && (program.as_bytes()[2] == b'\\' || program.as_bytes()[2] == b'/');

    if path.is_absolute()
        || path.has_root()
        || program.starts_with('/')
        || program.starts_with('\\')
        || is_windows_drive_path
    {
        return true;
    }

    let base_program = program
        .strip_suffix(".exe")
        .or_else(|| program.strip_suffix(".cmd"))
        .or_else(|| program.strip_suffix(".bat"))
        .unwrap_or(program);

    SANDBOX_ALLOWLIST
        .iter()
        .any(|allowed| base_program.eq_ignore_ascii_case(allowed))
}

/// Characters refused outright because a shell turns them into something other
/// than the command we validated.
///
/// `$` and the backtick are not negotiable: they expand to text chosen at run
/// time, so a program name could be assembled AFTER this check and never appear
/// in it (`CMD=rm` then `$CMD -rf /`). `(` and `)` build subshells, which are
/// another command list the segment check does not see. `<` and `>` read or
/// write arbitrary files. Separators are deliberately NOT in this list: they
/// only need each segment's program checked, which is done below.
///
/// A newline used to be missing from this list *and* from the separator set, so
/// `git status\nrm -rf /` passed validation (the first whitespace token is
/// `git`) and then ran both lines through `sh -c`. That was a hole in the
/// allowlist, not a policy choice.
const SHELL_METACHARACTERS: &[char] = &['$', '(', ')', '<', '>', '`'];

/// Characters that split a command into segments. Each segment's program is
/// checked against the allowlist, so accepting them adds no reach: `;` and a
/// newline are separators exactly like `&&`, and a `|` pipeline still runs only
/// programs that are already allowed.
///
/// This is the friction that mattered in practice. One install logged **325**
/// refusals for metacharacters, the common ones being `|`, `2>&1` and `;`
/// between two allowlisted programs. The agent's most ordinary request -
/// `find /home/admin/peraturan_pdf -maxdepth 1 -type f | head -30` - failed on
/// the pipe alone, even though `find` and `head` are both allowlisted.
const SHELL_SEPARATORS: &[char] = &[';', '\n', '\r'];

/// Validate a shell command for agent execution:
/// - refuse expansion, subshells and redirection (`$`, backtick, `(`, `)`, `<`, `>`)
/// - allow `&&`, `||`, `|`, `;` and newlines as separators, but check the program
///   of EVERY segment against the allowlist, not just the first
/// - drop the two redirections that cannot name a file (`N>&M`, `>/dev/null`)
/// - enforce the allowlist for each segment's program unless it is an absolute
///   path
/// - return the command string on success
pub fn validate_shell_command(command: &str) -> Result<&str, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

    // Remove the redirections that cannot name a file before the character scan,
    // so `2>&1` and `>/dev/null` are not mistaken for the `&` and `>` that are
    // refused. These two are the most common ways to keep output readable and
    // they cannot reach the filesystem, unlike `> file`.
    let cleaned = strip_dev_null_redirections(trimmed)?;

    // 1. Walk the command outside quotes: separators split it into segments, and
    //    anything that could turn into a different command is refused. A
    //    separator inside quotes is data, not a chain, so the quote state decides.
    let mut in_quote = false;
    let mut quote_char = '\0';
    let mut prev = '\0';
    let mut bad: Vec<char> = Vec::new();
    let chars = cleaned.chars().collect::<Vec<_>>();
    // Where each chained segment starts, so its program can be checked too.
    // Checking only the first token let `git status && rm -rf /` through: `git`
    // is allowlisted, so the second command ran unvalidated.
    let mut segment_starts: Vec<usize> = vec![0];
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_quote && (c == '"' || c == '\'') {
            in_quote = true;
            quote_char = c;
            prev = c;
            i += 1;
            continue;
        }
        if in_quote && c == quote_char && prev != '\\' {
            in_quote = false;
            quote_char = '\0';
            prev = c;
            i += 1;
            continue;
        }
        if !in_quote {
            if c == '&' {
                if i + 1 < chars.len() && chars[i + 1] == '&' {
                    // `&&` is a separator
                    segment_starts.push(i + 2);
                    i += 2;
                    prev = c;
                    continue;
                }
                // A lone `&` backgrounds the command, which hides it from the
                // segment check. `2>&1` and friends were already removed above.
                bad.push(c);
            } else if c == '|' {
                // Both `||` and a single `|` separate commands whose programs
                // are checked. A pipeline of allowlisted programs is exactly
                // what the agent needs and used to be refused.
                let step = if i + 1 < chars.len() && chars[i + 1] == '|' {
                    2
                } else {
                    1
                };
                segment_starts.push(i + step);
                i += step;
                prev = c;
                continue;
            } else if SHELL_SEPARATORS.contains(&c) {
                segment_starts.push(i + 1);
                prev = c;
                i += 1;
                continue;
            } else if SHELL_METACHARACTERS.contains(&c) {
                bad.push(c);
            }
        }
        prev = c;
        i += 1;
    }
    if in_quote {
        return Err("unclosed quote in command".into());
    }
    if !bad.is_empty() {
        let hint = if bad.contains(&'>') {
            "write the output with the write_file tool instead"
        } else if bad.contains(&'$') || bad.contains(&'`') {
            "shell expansion is refused because it can change which program runs"
        } else {
            "use a PTY session for what this would do"
        };
        return Err(format!(
            "command contains shell metacharacters {:?}; {hint}",
            bad
        ));
    }

    // 2. Every segment's program must be allowed. Segments are delimited by the
    //    chaining operators found above, so a quoted `&&` is still one segment.
    for start in &segment_starts {
        let rest: String = chars[*start..].iter().collect();
        let segment = rest.trim();
        if segment.is_empty() {
            return Err(
                "empty command in a `&&` / `||` chain; use a PTY session for arbitrary commands"
                    .into(),
            );
        }
        let raw_program = segment.split_whitespace().next().unwrap_or(segment);
        let program = raw_program.trim_matches(['"', '\'']);
        if !allows_program(program) {
            return Err(format!(
                "command '{}' is not in the agent allowlist; allowed: {:?}; use a PTY session to run arbitrary commands",
                program,
                SANDBOX_ALLOWLIST
            ));
        }
    }

    Ok(command)
}

/// Drop the redirections that cannot name a file: `N>&M` (join two of the
/// process's own streams) and `>/dev/null` (discard). Both are replaced with a
/// space so the character scan never sees the `&` or `>` they contain.
///
/// Everything else that redirects is left in place and therefore refused by the
/// scan, because `> file` writes wherever it is pointed - including the secret
/// paths the rest of the app refuses to touch. The caller runs the ORIGINAL
/// command, so the shell still performs these redirections.
fn strip_dev_null_redirections(command: &str) -> Result<String, String> {
    const DEV_NULL_LEN: usize = "/dev/null".len();
    let chars: Vec<char> = command.chars().collect();
    let mut out = String::with_capacity(command.len());
    let mut in_quote = false;
    let mut quote_char = '\0';
    let mut prev = '\0';
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_quote && (c == '"' || c == '\'') {
            in_quote = true;
            quote_char = c;
            out.push(c);
            prev = c;
            i += 1;
            continue;
        }
        if in_quote && c == quote_char && prev != '\\' {
            in_quote = false;
            quote_char = '\0';
            out.push(c);
            prev = c;
            i += 1;
            continue;
        }
        if !in_quote {
            // `N>&M`: two digits with a `>&` between them. A redirection to a
            // file always has a name (or `/dev/null`, matched below) after the
            // `>`, so a digit cannot be mistaken for a filename here.
            if c.is_ascii_digit()
                && chars.get(i + 1) == Some(&'>')
                && chars.get(i + 2) == Some(&'&')
                && chars.get(i + 3).is_some_and(|d| d.is_ascii_digit())
            {
                out.push(' ');
                prev = ' ';
                i += 4;
                continue;
            }
            // `>` or `N>` followed by `/dev/null`. A second `>` means append, so
            // `>>` is not matched and stays refused.
            let gt = if c == '>' {
                Some(i)
            } else if c.is_ascii_digit() && chars.get(i + 1) == Some(&'>') {
                Some(i + 1)
            } else {
                None
            };
            if let Some(gt) = gt {
                if chars.get(gt + 1) != Some(&'>') {
                    let mut j = gt + 1;
                    while chars.get(j) == Some(&' ') {
                        j += 1;
                    }
                    let is_dev_null = chars.len() >= j + DEV_NULL_LEN
                        && chars[j..j + DEV_NULL_LEN].iter().collect::<String>() == "/dev/null"
                        // The name must END there. `/dev/null.txt` and
                        // `/dev/null-backup` are ordinary files, and accepting
                        // them would let a redirection write to disk under a
                        // name that merely starts like the null device.
                        && chars.get(j + DEV_NULL_LEN).is_none_or(|a| {
                            a.is_whitespace()
                                || matches!(a, ';' | '|' | '&' | '<' | '>' | ')' | '"' | '\'')
                        });
                    if is_dev_null {
                        out.push(' ');
                        prev = ' ';
                        i = j + DEV_NULL_LEN;
                        continue;
                    }
                }
            }
        }
        out.push(c);
        prev = c;
        i += 1;
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Runs a one-shot command via the user's login shell. Output is capped and
/// the process is force-killed on timeout. We deliberately do NOT pipe into
/// the user's interactive PTY — that would fight their input. AI tool calls
/// are presented in chat as their own structured result.
#[tauri::command]
pub async fn shell_run_command(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<CommandOutput, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

    // Agent-triggered one-shot commands run through a restricted sandbox.
    validate_shell_command(&trimmed)?;

    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;
    let cwd_path = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    // The blocking spawn + wait runs on a worker thread so the Tauri async
    // runtime stays unblocked.
    let (tx, rx) = mpsc::channel::<Result<CommandOutput, String>>();
    thread::spawn(move || {
        let result = run_blocking(trimmed, cwd_path, workspace, dur, None);
        if tx.send(result).is_err() {
            log::warn!("shell_run_command: receiver dropped before result could be sent");
        }
    });

    rx.recv().map_err(|e| e.to_string())?
}

/// Somewhere the caller can see the child while it runs, so a command can be
/// stopped from outside instead of only by its own timeout.
pub(crate) type ChildSlot = Arc<std::sync::Mutex<Option<Arc<SharedChild>>>>;

/// Run a command, publishing the child into `slot` for its lifetime so it can
/// be stopped from outside.
pub(crate) fn run_blocking_interruptible(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
    slot: ChildSlot,
) -> Result<CommandOutput, String> {
    run_blocking(command, cwd, workspace, dur, Some(slot))
}

fn run_blocking(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
    slot: Option<ChildSlot>,
) -> Result<CommandOutput, String> {
    let mut cmd = build_oneshot_command(&command, &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(dir)) = (&workspace, cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| {
        log::warn!("shell_run_command spawn failed: {e}");
        e.to_string()
    })?);
    // Visible to `shell_session_interrupt` for as long as this runs. Cleared
    // below so a later interrupt cannot kill an unrelated process that has
    // since taken the same slot.
    if let Some(ref slot) = slot {
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(Arc::clone(&child));
        }
    }
    let mut stdout_pipe = child.take_stdout().ok_or_else(|| {
        let _ = child.kill();
        "no stdout pipe".to_string()
    })?;
    let mut stderr_pipe = child.take_stderr().ok_or_else(|| {
        let _ = child.kill();
        "no stderr pipe".to_string()
    })?;

    let stdout_handle = thread::spawn(move || drain(&mut stdout_pipe));
    let stderr_handle = thread::spawn(move || drain(&mut stderr_pipe));

    let (tx, rx) = mpsc::channel();
    // Cleared however this returns - normal exit, timeout or error - so a
    // later interrupt cannot kill a process that has since taken this slot.
    struct ClearOnDrop(Option<ChildSlot>);
    impl Drop for ClearOnDrop {
        fn drop(&mut self) {
            if let Some(slot) = self.0.take() {
                if let Ok(mut guard) = slot.lock() {
                    *guard = None;
                }
            }
        }
    }
    let _clear = ClearOnDrop(slot.clone());

    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });

    let (exit_code, timed_out) = match rx.recv_timeout(dur) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("shell wait thread disconnected".into());
        }
    };

    let (stdout_bytes, stdout_truncated) = stdout_handle.join().unwrap_or((Vec::new(), false));
    let (stderr_bytes, stderr_truncated) = stderr_handle.join().unwrap_or((Vec::new(), false));

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// Persistent agent shell state + background process state.
// ──────────────────────────────────────────────────────────────────────────

pub struct ShellState {
    sessions: RwLock<HashMap<u32, Arc<ShellSession>>>,
    bg: RwLock<HashMap<u32, Arc<BackgroundProc>>>,
    next_session_id: AtomicU32,
    next_bg_id: AtomicU32,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            bg: RwLock::new(HashMap::new()),
            next_session_id: AtomicU32::new(1),
            next_bg_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
pub fn shell_session_open(
    state: tauri::State<ShellState>,
    registry: tauri::State<WorkspaceRegistry>,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;
    let initial = match cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(c) => c.to_string(),
        None => {
            if let WorkspaceEnv::Wsl { distro } = &workspace {
                crate::modules::workspace::wsl_home_blocking(distro)?
            } else {
                let home = dirs::home_dir().ok_or_else(|| "unable to resolve home directory".to_string())?;
                crate::modules::fs::to_canon(home)
            }
        }
    };
    let session = Arc::new(ShellSession::new(initial, workspace));
    let id = state.next_session_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().unwrap().insert(id, session);
    Ok(id)
}

/// Kill whatever is running in a session right now.
///
/// The agent's stop button aborts the model stream, which does nothing to a
/// command already executing: the shell kept running and the user watched a
/// "stopped" agent stay busy. This is what makes stop reach the work.
#[tauri::command]
pub fn shell_session_interrupt(state: tauri::State<ShellState>, id: u32) -> Result<bool, String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no shell session".to_string())?;
    Ok(session.interrupt())
}

#[tauri::command]
pub async fn shell_session_run(
    state: tauri::State<'_, ShellState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    id: u32,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
) -> Result<SessionRunOutput, String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no shell session".to_string())?;
    let effective_workspace = workspace
        .as_ref()
        .unwrap_or(&session.workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), effective_workspace)?;

    // Interactive shell sessions already give the user a controlled environment,
    // but we still validate against shell metacharacters as a defense-in-depth
    // measure to prevent accidental injection from agent-driven sessions.
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    validate_shell_command(&trimmed)?;

    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = session.run(trimmed, cwd, workspace, dur);
        if tx.send(result).is_err() {
            log::warn!("shell_session_run: receiver dropped before result could be sent");
        }
    });
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn shell_session_close(state: tauri::State<ShellState>, id: u32) -> Result<(), String> {
    state.sessions.write().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
pub fn shell_bg_spawn(
    state: tauri::State<ShellState>,
    registry: tauri::State<WorkspaceRegistry>,
    command: String,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    log_path: Option<String>,
) -> Result<u32, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

    // Agent-triggered background commands run through the same sandbox.
    validate_shell_command(&trimmed)?;

    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;
    let proc = background::spawn(trimmed, cwd, workspace, log_path, &registry)?;
    let id = state.next_bg_id.fetch_add(1, Ordering::Relaxed);
    state.bg.write().unwrap().insert(id, proc);
    Ok(id)
}

#[tauri::command]
pub fn shell_bg_logs(
    state: tauri::State<ShellState>,
    handle: u32,
    since_offset: Option<u64>,
) -> Result<BackgroundLogResponse, String> {
    let proc = state
        .bg
        .read()
        .unwrap()
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no background handle".to_string())?;
    Ok(proc.read_logs(since_offset.unwrap_or(0)))
}

#[tauri::command]
pub fn shell_bg_kill(state: tauri::State<ShellState>, handle: u32) -> Result<bool, String> {
    if let Some(proc) = state.bg.read().unwrap().get(&handle).cloned() {
        Ok(proc.kill())
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn shell_bg_list(state: tauri::State<ShellState>) -> Result<Vec<BackgroundProcInfo>, String> {
    let map = state.bg.read().unwrap();
    let mut out = Vec::with_capacity(map.len());
    for (id, p) in map.iter() {
        out.push(p.info(*id));
    }
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

pub(crate) fn build_oneshot_command(
    command: &str,
    #[cfg_attr(not(windows), allow(unused_variables))] workspace: &WorkspaceEnv,
    #[cfg_attr(not(windows), allow(unused_variables))] cwd: Option<&str>,
) -> Result<Command, String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        validate_wsl_distro_name(distro)?;
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-d").arg(distro);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            let wsl_cwd = crate::modules::workspace::host_to_wsl_path(cwd, distro);
            cmd.arg("--cd").arg(wsl_cwd);
        }
        cmd.arg("--exec").arg("sh").arg("-lc").arg(command);
        return Ok(cmd);
    }
    #[cfg(unix)]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command);
        for (key, value) in crate::modules::workspace::appimage_env_overrides() {
            match value {
                Some(v) => {
                    cmd.env(key, v);
                }
                None => {
                    cmd.env_remove(key);
                }
            }
        }
        Ok(cmd)
    }
    #[cfg(windows)]
    {
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let mut cmd = Command::new(&shell);
        let is_cmd = shell
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("cmd.exe"))
            .unwrap_or(false);
        if is_cmd {
            cmd.arg("/C").arg(command);
        } else {
            cmd.arg("-NoProfile").arg("-Command").arg(command);
        }
        Ok(cmd)
    }
}

fn drain<R: Read>(reader: &mut R) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() >= MAX_OUTPUT_BYTES {
                    truncated = true;
                    continue;
                }
                let take = (MAX_OUTPUT_BYTES - out.len()).min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (out, truncated)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn run(cmd: &str, timeout_secs: u64) -> CommandOutput {
        // No child slot: these tests run a command to completion and never
        // interrupt one.
        run_blocking_interruptible(
            cmd.into(),
            None,
            WorkspaceEnv::Local,
            Duration::from_secs(timeout_secs),
            Default::default(),
        )
        .expect("run")
    }

    #[test]
    fn run_blocking_captures_stdout_and_zero_exit() {
        let out = run("printf 'hello\\n'", 5);
        assert_eq!(out.stdout, "hello\n");
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        assert!(!out.truncated);
    }

    #[test]
    fn run_blocking_captures_stderr_and_nonzero_exit() {
        let out = run("printf 'oops\\n' >&2; exit 3", 5);
        assert!(out.stderr.contains("oops"));
        assert_eq!(out.exit_code, Some(3));
    }

    #[test]
    fn run_blocking_times_out_long_running_command() {
        let out = run("sleep 10", 1);
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
    }

    #[test]
    fn run_blocking_truncates_huge_output() {
        let big = MAX_OUTPUT_BYTES + 4096;
        let out = run(&format!("head -c {big} /dev/zero"), 10);
        assert!(out.truncated);
        assert!(out.stdout.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn build_oneshot_command_uses_sh_minus_c_on_unix() {
        let cmd = build_oneshot_command("echo hi", &WorkspaceEnv::Local, None).unwrap();
        assert_eq!(cmd.get_program(), "/bin/sh");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-c", "echo hi"]);
    }
}

#[cfg(test)]
mod tests_sandbox {
    use super::*;

    #[test]
    fn validate_shell_command_allows_standard_tools() {
        assert!(validate_shell_command("git status").is_ok());
        assert!(validate_shell_command("npm test").is_ok());
        assert!(validate_shell_command("nmap -sV 127.0.0.1").is_ok());
        assert!(validate_shell_command("cargo check").is_ok());
        assert!(validate_shell_command("python script.py").is_ok());
    }

    /// The failure this covers, verbatim from a run: an agent tried to lint one
    /// file and was told `command 'biome' is not in the agent allowlist`. A
    /// coding agent has to be able to run the project's own checks, or it
    /// cannot verify what it changed.
    #[test]
    fn validate_shell_command_allows_project_toolchain() {
        for cmd in [
            "biome lint ./src",
            "biome check --reporter=summary .",
            "tsc --noEmit",
            "vitest run src/modules/ai/lib/regexEngine.test.ts",
            "knip",
            "eslint src",
            "prettier --check .",
            "pytest -q",
            "ruff check src",
            "mypy src",
            "golangci-lint run",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    /// Same binaries with a Windows extension and a version suffix, which is how
    /// they arrive from a package manager's shim directory.
    #[test]
    fn validate_shell_command_allows_toolchain_with_extension() {
        assert!(validate_shell_command("biome.exe lint ./src").is_ok());
        assert!(validate_shell_command("tsc.cmd --noEmit").is_ok());
        assert!(validate_shell_command("vitest.bat run").is_ok());
    }

    /// The allowlist is matched case-insensitively, so a differently-cased shim
    /// name is not a way to be rejected by surprise.
    #[test]
    fn validate_shell_command_allows_toolchain_case_insensitively() {
        assert!(validate_shell_command("Biome lint ./src").is_ok());
        assert!(validate_shell_command("TSC --noEmit").is_ok());
    }

    /// The fix must not have opened the door: an unknown binary is still
    /// refused, with the message that names the PTY escape hatch.
    #[test]
    fn validate_shell_command_still_refuses_unknown_programs() {
        let err = validate_shell_command("definitely-not-a-tool --go")
            .expect_err("unknown program must be refused");
        assert!(err.contains("not in the agent allowlist"), "{err}");
        assert!(err.contains("PTY session"), "{err}");
    }

    #[test]
    fn validate_shell_command_allows_windows_paths_and_extensions() {
        assert!(validate_shell_command(r#"C:\tools\mytool.exe --flag"#).is_ok());
        assert!(validate_shell_command(r#""C:\Program Files\tool.exe" arg"#).is_ok());
        assert!(validate_shell_command("git.exe status").is_ok());
    }

    #[test]
    fn validate_shell_command_blocks_metacharacters() {
        // Whatever can change WHICH program runs, or reach a file, stays out.
        assert!(validate_shell_command("echo hello > out.txt").is_err());
        assert!(validate_shell_command("echo hello >> out.txt").is_err());
        assert!(validate_shell_command("cat `id`").is_err());
        assert!(validate_shell_command("cat $(echo secret)").is_err());
        assert!(validate_shell_command("cat file < input").is_err());
        assert!(validate_shell_command("(git status)").is_err());
        // A lone `&` backgrounds the command, hiding it from the segment check.
        assert!(validate_shell_command("git status & git log").is_err());
    }

    /// A newline used to be neither a metacharacter nor a separator, so it
    /// passed the whole check and then ran as a second command through `sh -c`.
    /// `git` is allowlisted and is the first whitespace token, so
    /// `git status\nrm -rf /` was accepted and did both. That was a hole in the
    /// allowlist, not a policy choice.
    #[test]
    fn validate_shell_command_refuses_a_second_command_on_a_new_line() {
        let err = validate_shell_command("git status\nrm -rf /")
            .expect_err("a newline must not smuggle an unlisted program");
        assert!(err.contains("'rm'"), "{err}");
        assert!(validate_shell_command("git status\r\nshred -u f").is_err());
        assert!(validate_shell_command("pnpm test\nsudo rm -rf /").is_err());
        // A real second command on its own line is still checked and allowed
        // when its program is fine.
        assert!(validate_shell_command("git status\ngit log").is_ok());
    }

    /// The friction that mattered: a pipe between two allowlisted programs was
    /// refused 325 times on one install, including the agent's most ordinary
    /// request (`find ... | head -30`).
    #[test]
    fn validate_shell_command_allows_a_pipeline_of_allowlisted_programs() {
        assert!(validate_shell_command("find /tmp -maxdepth 1 -type f | head -30").is_ok());
        assert!(validate_shell_command("git log | head -20").is_ok());
        assert!(validate_shell_command("cat file | grep secret | wc -l").is_ok());
        assert!(validate_shell_command("ls -la | sort | uniq").is_ok());
    }

    /// A pipeline does not launder an unlisted program either: the pipe is only
    /// accepted because EVERY segment is still checked.
    #[test]
    fn validate_shell_command_refuses_a_pipeline_with_an_unlisted_segment() {
        let err = validate_shell_command("cat file | rm -rf /")
            .expect_err("an unlisted segment must be refused");
        assert!(err.contains("'rm'"), "{err}");
        assert!(validate_shell_command("git log | sh -c 'rm -rf /'").is_err());
        assert!(validate_shell_command("git log | sudo rm -rf /").is_err());
    }

    /// `;` is a separator exactly like `&&`, so each side is checked.
    #[test]
    fn validate_shell_command_allows_semicolons_between_allowlisted_programs() {
        assert!(validate_shell_command("git status; git log").is_ok());
        let err = validate_shell_command("git status; rm -rf /")
            .expect_err("an unlisted segment must be refused");
        assert!(err.contains("'rm'"), "{err}");
    }

    /// Two redirections cannot name a file, so they are removed before the scan:
    /// `N>&M` joins the process's own streams and `/dev/null` discards. They were
    /// among the most common refusals (`['>', '&']`).
    #[test]
    fn validate_shell_command_allows_stream_joins_and_dev_null() {
        assert!(validate_shell_command("pnpm test 2>&1").is_ok());
        assert!(validate_shell_command("pnpm test 1>&2").is_ok());
        assert!(validate_shell_command("pnpm test > /dev/null").is_ok());
        assert!(validate_shell_command("pnpm test 2>/dev/null").is_ok());
        assert!(validate_shell_command("git status 2>&1 | head -5").is_ok());
        assert!(validate_shell_command("git log 2>&1 | head -3 | wc -l").is_ok());
    }

    /// The exemption is narrow on purpose: anything that names a file, or that
    /// looks like `/dev/null` without being it, still goes through the scan and
    /// is refused. `guard_write` exists for the same reason on the write path.
    #[test]
    fn validate_shell_command_still_refuses_a_redirection_to_a_real_file() {
        assert!(validate_shell_command("echo x > /dev/nullx").is_err());
        assert!(validate_shell_command("echo x > /dev/null.txt").is_err());
        assert!(validate_shell_command("echo x > ~/.ssh/authorized_keys").is_err());
        assert!(validate_shell_command("echo x 2>> out.txt").is_err());
        assert!(validate_shell_command("echo x > out.txt 2>&1").is_err());
    }

    /// A redirection inside quotes is an argument, not a redirection, so it is
    /// left to the program and the `>` must not be treated as one.
    #[test]
    fn validate_shell_command_treats_a_quoted_redirection_as_data() {
        assert!(validate_shell_command(r#"grep "2>&1" src/file.ts"#).is_ok());
        assert!(validate_shell_command(r#"echo "> /dev/null""#).is_ok());
    }

    /// A chain of allowlisted programs is the case the chaining support exists
    /// for: `pnpm lint && pnpm test` is how the agent verifies its own work.
    #[test]
    fn validate_shell_command_allows_chains_of_allowlisted_programs() {
        assert!(validate_shell_command("pnpm lint && pnpm test").is_ok());
        assert!(validate_shell_command("biome lint ./src && tsc --noEmit").is_ok());
        assert!(validate_shell_command("git status || git log").is_ok());
        assert!(validate_shell_command("cargo fmt && cargo clippy").is_ok());
    }

    /// The reason chaining is safe to allow at all: every segment's program is
    /// checked, not just the first. Validating only the first token is what let
    /// `git status && rm -rf /` through, because `git` is allowlisted.
    #[test]
    fn validate_shell_command_refuses_a_chain_with_an_unlisted_later_segment() {
        let err = validate_shell_command("git status && rm -rf /")
            .expect_err("a destructive second command must be refused");
        assert!(err.contains("'rm'"), "{err}");
        assert!(err.contains("PTY session"), "{err}");

        assert!(validate_shell_command("pnpm test && sh -c 'x'").is_err());
        assert!(validate_shell_command("pnpm test || sudo rm -rf /").is_err());
        // Two levels of chaining do not launder the third program either.
        assert!(
            validate_shell_command("git status && pnpm test && shred -u f").is_err()
        );
    }

    /// A separator inside quotes is data. Splitting on it would turn `echo` into
    /// a two-segment chain and check a program that is really an argument.
    #[test]
    fn validate_shell_command_treats_a_quoted_separator_as_data() {
        assert!(validate_shell_command(r#"echo "a && b""#).is_ok());
        assert!(validate_shell_command(r#"echo 'x || y'"#).is_ok());
        assert!(validate_shell_command(r#"grep "a && b" src/file.ts"#).is_ok());
    }

    /// A dangling separator leaves a segment with no program to check.
    #[test]
    fn validate_shell_command_refuses_an_empty_chain_segment() {
        assert!(validate_shell_command("git status &&").is_err());
        assert!(validate_shell_command("&& git status").is_err());
        assert!(validate_shell_command("git status && ").is_err());
    }

    /// A binary the agent built is run by path, and that is allowed in a chain
    /// for the same reason it is allowed on its own: absolute or rooted only.
    #[test]
    fn validate_shell_command_allows_a_built_binary_by_path_in_a_chain() {
        assert!(
            validate_shell_command("pnpm build && /opt/termigo/target/release/mytool --help").is_ok()
        );
        assert!(validate_shell_command(r#"pnpm build && C:\tools\mytool.exe --flag"#).is_ok());
        // A relative path was never allowed, in a chain or out of one. Asserted
        // so the boundary is explicit rather than an accident of the allowlist.
        assert!(validate_shell_command("pnpm build && ./target/release/mytool --help").is_err());
    }

    #[test]
    fn validate_shell_command_allows_quoted_arguments() {
        assert!(validate_shell_command(r#"node -e "console.log(1+1)""#).is_ok());
        assert!(validate_shell_command(r#"echo "hello > world""#).is_ok());
        assert!(validate_shell_command(r#"echo 'hello | world'"#).is_ok());
    }
}
