pub mod background;
pub mod repl;
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
// `cargo build`) easily exceeds it and times out, so the agent re-runs it. 300s
// covers long test/build suites; pass `timeout_secs` (up to 900) for slower jobs.
const DEFAULT_TIMEOUT_SECS: u64 = 300;
const MAX_TIMEOUT_SECS: u64 = 900;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// Allowlisted read-only / inspection commands for agent-triggered execution.
/// Commands outside this set must be run through an interactive PTY session.
const SANDBOX_ALLOWLIST: &[&str] = &[
    "cat", "head", "tail", "wc", "grep", "rg", "sed", "awk",
    "find", "ls", "stat", "file", "xxd", "hexdump", "od",
    "git", "npm", "pnpm", "yarn", "cargo", "go", "python", "python3",
    "node", "deno", "bun", "make", "just", "task",
    "echo", "printf", "test", "true", "false", "pwd", "cd", "sleep", "rm", "cp", "mv", "del",
    "which", "where", "type", "command", "hash",
    "diff", "cmp", "comm", "patch", "jq", "yq",
    "tar", "gzip", "gunzip", "zip", "unzip",
    "curl", "wget", "http", "xh",
    "date", "uptime", "whoami", "id", "uname", "hostname",
    // Pentest & network recon tooling supported by Termigo
    "nmap", "masscan", "rustscan", "nikto", "nuclei", "httpx", "wpscan",
    "sqlmap", "ffuf", "gobuster", "dirsearch", "subfinder",
    "dig", "host", "nslookup", "ping", "traceroute", "tracepath", "mtr",
    "dnsx", "cmseek", "arjun",
    "tshark", "responder", "bettercap", "ettercap", "enum4linux", "smbclient",
    // Privilege elevation & package management (Linux/WSL, macOS, Windows)
    "sudo", "doas",
    // Linux / WSL package managers (Debian/Ubuntu/Kali, Arch, RedHat/Fedora, Alpine, openSUSE)
    "apt", "apt-get", "apt-cache", "dpkg", "dpkg-query",
    "pacman", "dnf", "yum", "rpm", "apk", "zypper", "snap", "flatpak",
    // macOS package management
    "brew", "port", "mas", "softwareupdate", "pkgutil", "installer",
    // Python packaging & tool runners
    "pip", "pip3", "pipx", "uv", "pipenv", "poetry", "conda", "pdm", "flit", "tox", "nox",
    // Node package runners & companion tools
    "npx", "bunx", "yarnpkg", "corepack",
    // Containers & virtualization
    "docker", "docker-compose", "podman",
    // Windows shell & package managers (parity with TERMIGO.md / security-model.md)
    "cmd", "powershell", "pwsh", "set", "wsl", "wslpath", "winget", "choco", "scoop",
    // Windows PowerShell cmdlets & shell utilities
    "Get-ChildItem", "Get-Content", "Get-Item", "Get-ItemProperty", "Get-Location", "Set-Location",
    "Test-Path", "Select-Object", "Select-String", "Where-Object", "ForEach-Object",
    "Measure-Object", "Sort-Object", "Group-Object", "Out-String", "Out-Null", "Out-File",
    "Write-Output", "Write-Host", "Remove-Item", "New-Item", "Copy-Item", "Move-Item", "Clear-Content",
    "Set-Content", "Add-Content", "Start-Process", "Stop-Process", "Get-Process", "Start-Sleep",
    "Get-Command", "Resolve-Path", "Split-Path", "Join-Path", "Expand-Archive", "Compress-Archive",
    "Invoke-WebRequest", "Invoke-RestMethod", "ConvertFrom-Json", "ConvertTo-Json",
    "Get-NetTCPConnection", "Get-NetIPAddress", "Get-NetRoute", "Test-NetConnection",
    "Get-CimInstance", "Get-WmiObject", "Get-Service", "Start-Service", "Stop-Service", "Restart-Service",
    "Format-Table", "Format-List", "ft", "fl",
    "dir", "del", "cls", "ver", "copy", "move", "ren", "rename", "md", "rd", "tree",
    "findstr", "tasklist", "taskkill", "wmic", "fc", "attrib", "systeminfo", "net", "route", "arp", "netsh",
    // Linux/WSL and Unix system administration & root utilities (user-approved)
    "systemctl", "service", "journalctl", "dmesg",
    "chown", "chmod", "mkdir", "rm", "rmdir", "cp", "mv", "touch", "ln", "tee",
    "ip", "ifconfig", "netstat", "ss", "lsof", "ps", "pidof", "pgrep", "kill", "pkill", "killall",
    "free", "df", "du", "ufw", "iptables",
    "timeout",
    "useradd", "usermod", "userdel", "groupadd", "groupmod", "groupdel",
    "apt-key", "gpg", "update-alternatives", "su",
    "xargs", "env", "printenv", "basename", "dirname", "realpath", "readlink",
    "cut", "sort", "uniq", "tr", "fold", "paste", "split", "nl",
    // SSH & remote transfer utilities
    "ssh", "scp", "sftp", "rsync",
    // JS/TS project toolchains & web frameworks
    "biome", "tsc", "vitest", "knip", "vite", "eslint", "prettier",
    "jest", "mocha", "playwright", "size-limit",
    "prisma", "tsx", "ts-node", "next", "turbo", "tailwindcss", "postcss",
    "webpack", "rollup", "esbuild", "svelte-check", "astro", "remix", "nuxt",
    "drizzle-kit", "typeorm", "knex", "sass", "less", "oxlint", "cypress",
    "rimraf", "cross-env", "concurrently", "nodemon", "pm2", "serve", "http-server", "live-server",
    "terser", "swc", "babel",
    // Databases & query engines
    "sqlite3", "duckdb", "psql", "mysql", "mongosh", "redis-cli",
    // Python toolchains
    "ruff", "black", "mypy", "pytest", "flake8", "isort",
    // Go / Rust helpers and compilers
    "rustc", "rustup", "cargo-nextest", "cargo-clippy", "cargo-machete",
    "golangci-lint", "rustfmt", "clippy-driver", "gofmt", "govulncheck", "dlv",
];

/// Characters that enable command injection in a shell one-liner.
const SHELL_METACHARACTERS: &[char] = &['$', '(', ')', '<', '>', '`'];

/// Check whether a token is an environment variable assignment like `FOO=bar` or
/// `DEBIAN_FRONTEND=noninteractive`.
fn is_env_var_assignment(token: &str) -> bool {
    let clean = token.trim_matches(['"', '\'']);
    if let Some((name, _)) = clean.split_once('=') {
        let mut chars = name.chars();
        if let Some(first) = chars.next() {
            return (first.is_ascii_alphabetic() || first == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        }
    }
    false
}

/// Extract the effective program to validate against the sandbox allowlist.
///
/// Skips leading environment variable prefixes (e.g. `LC_ALL=C ls`,
/// `DEBIAN_FRONTEND=noninteractive apt-get install`).
///
/// For wrappers (`wsl`, `sudo`, `doas`), unpacks flags and options (including
/// those taking arguments like `-u <user>`, `-g <group>`, `-d <distro>`) to find the
/// target program being executed. Chained wrappers (e.g. `wsl sudo apt update`)
/// are unwrapped sequentially so that `wsl sudo unallowed_binary --flag` fails on `unallowed_binary`, while
/// `wsl sudo apt update` succeeds on `apt`. If no subcommand follows (e.g. `sudo -l`,
/// `wsl --status`), the wrapper itself is checked.
fn extract_effective_program(segment: &str) -> &str {
    let mut words = segment.split_whitespace();

    let mut current_word = None;
    for word in words.by_ref() {
        let w = word.trim_matches(['"', '\'']);
        if !is_env_var_assignment(w) {
            current_word = Some(w);
            break;
        }
    }

    let mut current = match current_word {
        Some(w) => w,
        None => return segment,
    };

    loop {
        let base = current
            .strip_suffix(".exe")
            .or_else(|| current.strip_suffix(".cmd"))
            .or_else(|| current.strip_suffix(".bat"))
            .unwrap_or(current);

        let prog_name = base
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(base);

        let is_wsl = prog_name.eq_ignore_ascii_case("wsl");
        let is_sudo = prog_name.eq_ignore_ascii_case("sudo") || prog_name.eq_ignore_ascii_case("doas");
        let is_su = prog_name.eq_ignore_ascii_case("su");
        let is_ps =
            prog_name.eq_ignore_ascii_case("powershell") || prog_name.eq_ignore_ascii_case("pwsh");

        if !is_wsl && !is_sudo && !is_su && !is_ps {
            return current;
        }

        let mut target = None;
        let mut skip_next = false;
        let mut expect_cmd = false;
        for word in words.by_ref() {
            let w = word.trim_matches(['"', '\'']);
            if skip_next {
                skip_next = false;
                continue;
            }
            if expect_cmd {
                let sub_cmd = w.split_whitespace().next().unwrap_or(w).trim_matches(['"', '\'']);
                target = Some(sub_cmd);
                break;
            }
            if w == "--" {
                continue;
            }
            if is_env_var_assignment(w) {
                continue;
            }
            // `powershell -Command "<script>"` executes the inner script (the
            // persistent shell unwraps exactly this form), so the allowlist
            // must see the script's program, not `powershell`. Flags are
            // case-insensitive in PowerShell; value-taking display flags are
            // skipped like their wsl/sudo counterparts.
            if is_ps {
                if w.eq_ignore_ascii_case("-c") || w.eq_ignore_ascii_case("-command") {
                    expect_cmd = true;
                    continue;
                }
                if w.starts_with('-') {
                    if !w.contains('=')
                        && matches!(
                            w.to_ascii_lowercase().as_str(),
                            "-executionpolicy" | "-windowstyle" | "-outputformat" | "-inputformat" | "-file"
                        )
                    {
                        skip_next = true;
                    }
                    continue;
                }
                target = Some(w);
                break;
            }
            if is_su {
                if w == "-c" || w == "--command" {
                    expect_cmd = true;
                    continue;
                }
                if let Some(cmd_part) = w.strip_prefix("--command=") {
                    let clean = cmd_part.trim_matches(['"', '\'']);
                    let sub_cmd = clean.split_whitespace().next().unwrap_or(clean).trim_matches(['"', '\'']);
                    target = Some(sub_cmd);
                    break;
                }
                if w.starts_with('-') {
                    continue;
                }
                // Bare user parameter like `root` in `su root -c ...`
                continue;
            }
            if w.starts_with('-') {
                if is_wsl {
                    if w == "-e" || w == "--exec" {
                        // -e / --exec directly precedes the target command (e.g. `wsl -e cargo test`).
                        continue;
                    }
                    if !w.contains('=')
                        && matches!(
                            w,
                            "-d" | "--distribution" | "-u" | "--user" | "--cd" | "--shell-type"
                        )
                    {
                        skip_next = true;
                    }
                } else if !w.contains('=')
                    && matches!(
                        w,
                        "-u" | "-g" | "-p" | "-C" | "-c" | "-r" | "-t" | "-T" | "-D" | "-h" | "-U"
                            | "--user" | "--group" | "--prompt" | "--close-from"
                            | "--login-class" | "--role" | "--type" | "--command-timeout"
                            | "--chdir" | "--host" | "--other-user"
                    )
                {
                    skip_next = true;
                }
                continue;
            }
            target = Some(w);
            break;
        }

        match target {
            Some(t) => current = t,
            None => return current,
        }
    }
}

/// Check if the slice at `chars[i..]` matches a safe stdout/stderr discard redirection.
/// Matches: `> /dev/null`, `>/dev/null`, `> nul`, `>nul`, `2> /dev/null`, `2>/dev/null`,
/// `2> nul`, `2>nul`, `1> /dev/null`, `1>/dev/null`, `1> nul`, `1>nul`, `&> /dev/null`,
/// `&>/dev/null`, `&> nul`, `&>nul` (case-insensitive), and PowerShell's `$null`.
/// Returns the number of characters consumed if matched.
fn match_discard_redirection(chars: &[char], i: usize) -> Option<usize> {
    let rem = &chars[i..];
    // Check optional prefix: '1', '2', or '&'
    let (has_prefix, after_prefix) = match rem.first() {
        Some(&p) if p == '1' || p == '2' || p == '&' => (true, &rem[1..]),
        _ => (false, rem),
    };

    if after_prefix.first() != Some(&'>') {
        return None;
    }

    let mut idx = if has_prefix { 2 } else { 1 };
    // Skip whitespace after '>'
    while idx < rem.len() && (rem[idx] == ' ' || rem[idx] == '\t') {
        idx += 1;
    }

    // Check target: "/dev/null" or "nul" (case-insensitive)
    let target_chars = &rem[idx..];
    if target_chars.len() >= 9 {
        let candidate: String = target_chars[..9].iter().collect();
        if candidate == "/dev/null" {
            let next = target_chars.get(9);
            if next.is_none()
                || next.unwrap().is_whitespace()
                || matches!(next.unwrap(), ';' | '&' | '|' | '\n' | '\r')
            {
                return Some(idx + 9);
            }
        }
    }
    if target_chars.len() >= 3 {
        let candidate: String = target_chars[..3].iter().collect();
        if candidate.eq_ignore_ascii_case("nul") {
            let next = target_chars.get(3);
            if next.is_none()
                || next.unwrap().is_whitespace()
                || matches!(next.unwrap(), ';' | '&' | '|' | '\n' | '\r')
            {
                return Some(idx + 3);
            }
        }
    }
    // PowerShell's `$null` is the idiomatic discard target, equivalent to `nul`.
    // It is only ever matched after a `>`, so it cannot act as a substitution.
    if target_chars.len() >= 5 {
        let candidate: String = target_chars[..5].iter().collect();
        if candidate.eq_ignore_ascii_case("$null") {
            let next = target_chars.get(5);
            if next.is_none()
                || next.unwrap().is_whitespace()
                || matches!(next.unwrap(), ';' | '&' | '|' | '\n' | '\r')
            {
                return Some(idx + 5);
            }
        }
    }

    None
}

/// Validate a shell command for agent execution:
/// - reject metacharacters that enable injection (`;$()<>``)
/// - allow safe chaining operators `&&` and `||`
/// - reject raw newlines/control chars, which are hidden command separators
/// - allow `&&`/`||` chaining, but enforce the allowlist on EVERY segment
/// - return the command string on success
pub fn validate_shell_command(command: &str) -> Result<&str, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

    // 1. Reject stray control characters (NUL, BEL, ...). `\t` is treated as
    //    whitespace; `\n` and `\r` are refused below as hidden separators.
    if trimmed
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err("command contains control characters".into());
    }

    // 2. Reject metacharacters outside quotes, and split the command into
    //    `&&`/`||`/`|`/`;`-separated segments. `&&`/`||`/`|`/`;` are allowed as separators,
    //    but every segment's program is checked in step 3 - so `git && unallowed_binary` is
    //    refused on `unallowed_binary`, which was the hole when only the first token was read.
    let mut in_quote = false;
    let mut quote_char = '\0';
    let mut prev = '\0';
    let mut bad: Vec<char> = Vec::new();
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars = trimmed.chars().collect::<Vec<_>>();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_quote && (c == '"' || c == '\'') {
            let mut backslashes = 0;
            let mut j = i;
            while j > 0 && chars[j - 1] == '\\' {
                backslashes += 1;
                j -= 1;
            }
            if backslashes % 2 == 0 {
                in_quote = true;
                quote_char = c;
            }
        } else if in_quote && c == quote_char {
            let mut backslashes = 0;
            let mut j = i;
            while j > 0 && chars[j - 1] == '\\' {
                backslashes += 1;
                j -= 1;
            }
            if backslashes % 2 == 0 {
                in_quote = false;
                quote_char = '\0';
            }
        } else if !in_quote {
            // Stderr redirection `2>&1` merges streams rather than writing files or chaining commands.
            // Preserve it intact without adding `>` or `&` to the metacharacter reject list.
            if c == '2'
                && chars.get(i + 1) == Some(&'>')
                && chars.get(i + 2) == Some(&'&')
                && chars.get(i + 3) == Some(&'1')
            {
                current.push_str("2>&1");
                prev = '1';
                i += 4;
                continue;
            }
            // Standard output/error discard redirections like `> /dev/null`, `>/dev/null`,
            // `> nul`, `>nul`, `2> /dev/null`, `2>/dev/null`, `2> nul`, `2>nul`, `1> /dev/null`,
            // `1> nul`, `&> /dev/null`, `&> nul`.
            if let Some(len) = match_discard_redirection(&chars, i) {
                for &ch in &chars[i..i + len] {
                    current.push(ch);
                }
                prev = chars[i + len - 1];
                i += len;
                continue;
            }
            let chained = (c == '&' && chars.get(i + 1) == Some(&'&'))
                || (c == '|' && chars.get(i + 1) == Some(&'|'));
            if chained {
                if current.trim().is_empty() {
                    return Err("command contains an empty or dangling segment".into());
                }
                segments.push(std::mem::take(&mut current));
                prev = c;
                i += 2;
                continue;
            }
            if c == '|' {
                if current.trim().is_empty() {
                    return Err("command contains an empty or dangling segment".into());
                }
                segments.push(std::mem::take(&mut current));
                prev = c;
                i += 1;
                continue;
            }
            if c == ';' {
                if current.trim().is_empty() {
                    return Err("command contains an empty or dangling segment".into());
                }
                segments.push(std::mem::take(&mut current));
                prev = c;
                i += 1;
                continue;
            }
            // A raw newline or carriage return is a hidden command separator the
            // allowlist cannot reason about, so refuse it instead of splitting.
            if c == '\n' || c == '\r' || c == '&' || SHELL_METACHARACTERS.contains(&c) {
                bad.push(c);
            }
        }
        current.push(c);
        prev = c;
        i += 1;
    }
    if in_quote {
        return Err("unclosed quote in command".into());
    }
    if !bad.is_empty() {
        return Err(format!(
            "command contains shell metacharacters {:?}; chain with `;` / `&&` / `||`, discard output with `> nul` or `2>$null`, and use a PTY session for grouping, variables or substitution",
            bad
        ));
    }
    if !current.trim().is_empty() {
        segments.push(current);
    } else if segments.is_empty() || (prev != ';' && prev != '\0') {
        return Err("command contains an empty or dangling segment".into());
    }

    // 3. Every segment must start with an allowlisted program (or an absolute /
    //    rooted path). Checking each segment - not just the first - is what
    //    makes `git status && unallowed_binary` fail on `unallowed_binary`.
    let segments: Vec<&str> = segments
        .iter()
        .map(|s| s.trim())
        .collect();
    if segments.is_empty() || segments.iter().any(|s| s.is_empty()) {
        return Err("command contains no executable segment".into());
    }
    for segment in segments {
        let raw_program = extract_effective_program(segment);
        let program = raw_program.trim_matches(['"', '\'']);

        // Allow absolute or rooted paths on Unix (/...) and Windows (C:\..., \...).
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
            continue;
        }

        // Strip executable extensions for matching (.exe, .cmd, .bat).
        let base_program = program
            .strip_suffix(".exe")
            .or_else(|| program.strip_suffix(".cmd"))
            .or_else(|| program.strip_suffix(".bat"))
            .unwrap_or(program);

        // For relative paths (e.g. `./node_modules/.bin/vitest` or `.\bin\npx`), extract the file name
        // using cross-platform separators ('/' and '\\') so Windows-style paths validate on Unix.
        let file_name = base_program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(base_program);

        if SANDBOX_ALLOWLIST
            .iter()
            .any(|allowed| base_program.eq_ignore_ascii_case(allowed) || file_name.eq_ignore_ascii_case(allowed))
        {
            continue;
        }

        return Err(format!(
            "command '{}' is not in the agent allowlist; allowed: {:?}; use a PTY session to run arbitrary commands",
            program,
            SANDBOX_ALLOWLIST
        ));
    }

    Ok(command)
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
    // runtime stays unblocked. The wait below must too: a bare `rx.recv()`
    // here would park an async worker for up to the whole timeout, starving
    // concurrent agent calls of runtime threads.
    let (tx, rx) = mpsc::channel::<Result<CommandOutput, String>>();
    thread::spawn(move || {
        let result = run_blocking(trimmed, cwd_path, workspace, dur, None);
        if tx.send(result).is_err() {
            log::warn!("shell_run_command: receiver dropped before result could be sent");
        }
    });

    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
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
    #[cfg(windows)]
    let _job = crate::modules::proc::job::ProcessJob::create_for(child.id()).ok();
    let kill_child = |c: &SharedChild| {
        crate::modules::proc::kill_tree(c.id());
        let _ = c.kill();
    };
    // Visible to `shell_session_interrupt` for as long as this runs. Cleared
    // below so a later interrupt cannot kill an unrelated process that has
    // since taken the same slot.
    if let Some(ref slot) = slot {
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(Arc::clone(&child));
        }
    }
    let mut stdout_pipe = child.take_stdout().ok_or_else(|| {
        kill_child(&child);
        "no stdout pipe".to_string()
    })?;
    let mut stderr_pipe = child.take_stderr().ok_or_else(|| {
        kill_child(&child);
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
            kill_child(&child);
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
    repls: RwLock<HashMap<u32, Arc<repl::ReplProc>>>,
    next_session_id: AtomicU32,
    next_bg_id: AtomicU32,
    next_repl_id: AtomicU32,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            bg: RwLock::new(HashMap::new()),
            repls: RwLock::new(HashMap::new()),
            next_session_id: AtomicU32::new(1),
            next_bg_id: AtomicU32::new(1),
            next_repl_id: AtomicU32::new(1),
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
    // Off the async worker: `session.run` blocks up to the whole timeout, and
    // a bare recv here would park the executor thread with it.
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
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
        out.push(p.info((*id).into()));
    }
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

/// Start an interactive process the agent can hold a conversation with.
///
/// Separate from `shell_bg_spawn` because of one line in the spawn: this one
/// keeps stdin. A daemon should not inherit stdin; a debugger is useless
/// without it.
#[tauri::command]
pub fn repl_open(
    state: tauri::State<ShellState>,
    registry: tauri::State<WorkspaceRegistry>,
    command: String,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<u32, String> {
    // Agent-triggered interactive processes run through the same restricted
    // sandbox as one-shot and background commands. Without this any binary
    // spawns here while the other entry points refuse it.
    validate_shell_command(command.trim())?;
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;

    // Reap first: an agent that finishes a debugging session rarely remembers
    // to call `repl_close`, so most of what accumulates here has already
    // exited and is holding nothing but a map entry.
    {
        let mut map = state.repls.write().unwrap();
        map.retain(|_, p| !p.exited.load(Ordering::Acquire));
        // Then a hard cap on what is genuinely still running. Each live REPL
        // holds a process, two reader threads and its pipes; an agent in a
        // retry loop would otherwise spawn them without limit. Same shape as
        // the LSP session cap, and for the same reason.
        if map.len() >= repl::MAX_LIVE {
            return Err(format!(
                "too many interactive processes are running ({}); close one with repl_stop first",
                map.len()
            ));
        }
    }

    let proc = repl::spawn(command, cwd, workspace)?;
    let id = state.next_repl_id.fetch_add(1, Ordering::Relaxed);
    state.repls.write().unwrap().insert(id, proc);
    Ok(id)
}

/// Read from a running process, optionally sending a line first.
///
/// One command rather than a send and a read, because every use is both: you
/// write `next` and you want what came back. Sending nothing is how you wait
/// again after a timeout, or read what the process printed on startup.
#[tauri::command]
pub async fn repl_send(
    state: tauri::State<'_, ShellState>,
    handle: u32,
    input: Option<String>,
    until: Option<String>,
    since_offset: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<repl::ReplTurn, String> {
    let proc = state
        .repls
        .read()
        .unwrap()
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no repl handle".to_string())?;
    if let Some(line) = input {
        proc.send_line(&line)?;
    }
    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(repl::DEFAULT_WAIT_SECS)
            .clamp(1, repl::MAX_WAIT_SECS),
    );
    let since = since_offset.unwrap_or(0);
    // The wait itself runs off-thread, but the `rx.recv()` below must not run
    // on the async worker either: it blocks for up to ten minutes, starving
    // the runtime threads every concurrent agent call shares.
    let (tx, rx) = mpsc::channel();
    let needle = until;
    thread::spawn(move || {
        let _ = tx.send(proc.wait_for(since, needle.as_deref(), dur));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn repl_close(state: tauri::State<ShellState>, handle: u32) -> Result<(), String> {
    if let Some(proc) = state.repls.write().unwrap().remove(&handle) {
        proc.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn repl_list(state: tauri::State<ShellState>) -> Result<Vec<repl::ReplInfo>, String> {
    let map = state.repls.read().unwrap();
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
        assert!(validate_shell_command("echo hello > out.txt").is_err());
        assert!(validate_shell_command("cat `id`").is_err());
        assert!(validate_shell_command("echo $HOME").is_err());
    }

    #[test]
    fn validate_shell_command_allows_pipelines_and_sleep() {
        assert!(validate_shell_command("cat file | grep secret").is_ok());
        assert!(validate_shell_command("cat file | grep secret | wc -l").is_ok());
        assert!(validate_shell_command("ps aux | grep node").is_ok());
        assert!(validate_shell_command("sleep 5").is_ok());
        assert!(validate_shell_command("cat file | definitely-not-a-tool").is_err());
        assert!(validate_shell_command("cat file |").is_err());
        assert!(validate_shell_command("| grep secret").is_err());
    }

    #[test]
    fn validate_shell_command_allows_mkdir_and_rm() {
        assert!(validate_shell_command("mkdir -p /tmp/test").is_ok());
        assert!(validate_shell_command("rm -f /tmp/test/foo").is_ok());
        assert!(validate_shell_command("mkdir -p /tmp/test && rm -f /tmp/test/foo").is_ok());
        assert!(validate_shell_command("rmdir /tmp/test").is_ok());
        assert!(validate_shell_command("cp src.txt dst.txt").is_ok());
        assert!(validate_shell_command("mv src.txt dst.txt").is_ok());
        assert!(validate_shell_command("del file.txt").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_quoted_arguments() {
        assert!(validate_shell_command(r#"node -e "console.log(1+1)""#).is_ok());
        assert!(validate_shell_command(r#"echo "hello > world""#).is_ok());
        assert!(validate_shell_command(r#"echo 'hello | world'"#).is_ok());
    }

    /// Every `&&`/`||` segment is checked against the allowlist, so an
    /// allowlisted first token cannot smuggle a non-allowlisted command past it.
    #[test]
    fn validate_shell_command_enforces_allowlist_on_every_segment() {
        assert!(validate_shell_command("git status && git diff").is_ok());
        assert!(validate_shell_command("npm test && cargo check").is_ok());
        assert!(validate_shell_command("git status || git fetch").is_ok());
        assert!(validate_shell_command("git log && definitely-not-a-tool").is_err());
        assert!(validate_shell_command("git log || definitely-not-a-tool").is_err());
        // A dangling operator leaves an empty segment.
        assert!(validate_shell_command("git status &&").is_err());
    }

    /// A raw newline is a hidden command separator: the allowlist only sees the
    /// first line, so it must be refused outright rather than executed.
    #[test]
    fn validate_shell_command_rejects_newline_injection() {
        let err = validate_shell_command("echo hi\nrm -rf /")
            .expect_err("newline injection must be refused");
        assert!(err.contains("PTY session"), "{err}");
        assert!(validate_shell_command("echo hi\r\nwhoami").is_err());
        // A tab is not a separator and stays allowed.
        assert!(validate_shell_command("echo hi\tthere").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_linux_wsl_and_macos_package_managers() {
        for cmd in [
            "apt update",
            "apt install -y nmap",
            "apt-get update",
            "apt-get install -y curl",
            "apt-cache search sqlmap",
            "dpkg -l",
            "dpkg -i tool.deb",
            "pacman -Syu",
            "dnf install -y nginx",
            "yum check-update",
            "apk add --no-cache git",
            "zypper refresh",
            "brew install ripgrep",
            "brew update",
            "brew search python",
            "port install htop",
            "softwareupdate -l",
            "pip install requests",
            "pip3 install termcolor",
            "pipx install impacket",
            "uv pip install ruff",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_allows_sudo_with_allowlisted_tools() {
        for cmd in [
            "sudo apt update",
            "sudo apt-get install -y nmap",
            "sudo -u root apt install -y curl",
            "sudo -E apt update",
            "sudo -S apt update",
            "sudo -- apt update",
            "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nmap",
            "DEBIAN_FRONTEND=noninteractive apt-get install -y nmap",
            "sudo brew update",
            "sudo pacman -Syu",
            "sudo -l",
            "sudo --version",
            "doas apt update",
            "doas -u root apt install -y htop",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_refuses_sudo_with_unallowlisted_tools() {
        assert!(validate_shell_command("sudo evil-binary --flag").is_err());
        assert!(validate_shell_command("sudo -u root definitely-not-a-tool").is_err());
        assert!(validate_shell_command("doas definitely-not-a-tool").is_err());
        assert!(validate_shell_command("sudo rm -f /tmp/test").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_su_with_allowlisted_tools() {
        for cmd in [
            "su -c \"apt update\"",
            "su -c 'apt update'",
            "su --command=\"apt update\"",
            "su root -c \"apt update\"",
            "su - root -c \"apt update\"",
            "su -l root -c \"apt update\"",
            "su -c \"ls -la\"",
            "su -c \"git status\"",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_refuses_su_with_unallowlisted_tools() {
        assert!(validate_shell_command("su -c \"evil-binary --flag\"").is_err());
        assert!(validate_shell_command("su root -c \"definitely-not-a-tool\"").is_err());
        assert!(validate_shell_command("su --command=\"evil-binary\"").is_err());
    }

    #[test]
    fn validate_shell_command_sees_through_powershell_command() {
        // The persistent shell unwraps exactly this form before executing, so
        // the allowlist must judge the inner script, not `powershell`.
        for cmd in [
            "powershell -Command \"Get-ChildItem -Path .\"",
            "powershell -NoProfile -Command \"Get-Content file.txt\"",
            "pwsh -c \"git status\"",
            "powershell -ExecutionPolicy Bypass -Command \"Get-Process\"",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_refuses_powershell_command_hiding_tools() {
        // (nmap would NOT qualify: scanners are deliberately allowlisted for
        // the pentest kit; the scope fence, not this list, constrains them.)
        assert!(validate_shell_command("powershell -Command \"evil-binary --flag\"").is_err());
        assert!(validate_shell_command("pwsh -c \"definitely-not-a-tool\"").is_err());
        assert!(validate_shell_command("powershell -NoProfile -Command \"evil-binary\"").is_err());
    }

    #[test]
    fn validate_shell_command_allows_wsl_with_allowlisted_tools() {
        for cmd in [
            "wsl apt update",
            "wsl sudo apt update",
            "wsl -d Kali sudo apt-get install -y nmap",
            "wsl -u root apt install -y curl",
            "wsl --distribution=Kali apt update",
            "wsl -e git status",
            "wsl -e cargo test",
            "wsl --exec ls -la",
            "wsl -d Ubuntu -e pnpm test",
            "wsl --status",
            "wsl -l -v",
            "wslpath -w /etc",
            "wsl rm -f /tmp/test",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
        assert!(validate_shell_command("wsl definitely-not-a-tool").is_err());
        assert!(validate_shell_command("wsl -d Kali definitely-not-a-tool").is_err());
        assert!(validate_shell_command("wsl sudo definitely-not-a-tool").is_err());
        assert!(validate_shell_command("wsl -e definitely-not-a-tool").is_err());
    }

    #[test]
    fn validate_shell_command_allows_ssh_and_remote_transfer() {
        for cmd in [
            "ssh user@vps-server uptime",
            "ssh -p 2222 root@192.168.1.100 uname -a",
            "ssh -i /path/to/key.pem ubuntu@ec2-host df -h",
            "scp local.txt user@vps:/tmp/local.txt",
            "sftp user@vps",
            "rsync -avz ./dist user@vps:/var/www/html",
            "wsl ssh user@vps uptime",
            "sudo ssh user@vps",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_allows_expanded_developer_and_system_tools() {
        for cmd in [
            "npx create-next-app@latest my-app",
            "npx tsc --noEmit",
            "npx tsx prisma/seed.ts",
            "bunx prettier --check .",
            "prisma generate",
            "next build",
            "docker ps",
            "docker-compose up -d",
            "podman images",
            "rustc --version",
            "rustup show",
            "cargo-nextest run",
            "cargo-clippy --all-targets",
            "pipenv install",
            "poetry run pytest",
            "conda list",
            "dig example.com",
            "host example.com",
            "nslookup example.com",
            "ping -c 4 127.0.0.1",
            "xargs -n 1 echo",
            "tshark -r capture.pcap",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_allows_powershell_and_windows_tools() {
        for cmd in [
            "Get-ChildItem -Path ./src",
            "Get-Content package.json",
            "Get-Item C:\\project",
            "Get-Location",
            "Set-Location C:\\project",
            "Test-Path ./package.json",
            "Select-Object -First 10",
            "Select-String -Pattern \"fn\" mod.rs",
            "Remove-Item -Recurse ./dist",
            "Start-Sleep -Seconds 2",
            "findstr /i \"hello\" test.txt",
            "tasklist",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_allows_semicolons_and_stderr_redirect() {
        assert!(validate_shell_command("cd dir; npx create-next-app").is_ok());
        assert!(validate_shell_command(r#"cd C:\project\sampel; npx create-next-app@latest masjid-raya-pro 2>&1"#).is_ok());
        assert!(validate_shell_command("git status; git branch;").is_ok());
        assert!(validate_shell_command("npm test 2>&1").is_ok());
        assert!(validate_shell_command("Get-Content file.txt; Select-String pattern").is_ok());
        assert!(validate_shell_command("; git status").is_err());
        assert!(validate_shell_command("git status; definitely-not-a-tool").is_err());
    }

    #[test]
    fn validate_shell_command_allows_relative_path_tools() {
        assert!(validate_shell_command("./node_modules/.bin/vitest run").is_ok());
        assert!(validate_shell_command(r#".\node_modules\.bin\tsc.cmd --noEmit"#).is_ok());
        assert!(validate_shell_command("./node_modules/.bin/prisma migrate").is_ok());
        assert!(validate_shell_command("./bin/npx --version").is_ok());
        assert!(validate_shell_command("./node_modules/.bin/definitely-not-allowed").is_err());
    }

    #[test]
    fn validate_shell_command_allows_full_stack_tools_and_discard_redirects() {
        for cmd in [
            "sqlite3 database.db \".tables\"",
            "duckdb -c \"SELECT 1\"",
            "psql -U postgres -d mydb",
            "drizzle-kit generate",
            "nuxt build",
            "cross-env NODE_ENV=production next build",
            "rimraf dist",
            "cypress run",
            "tree src",
            "Get-Command npx",
            "Resolve-Path ./src",
            "Start-Process node",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }

        assert!(validate_shell_command("npm run build > /dev/null 2>&1").is_ok());
        assert!(validate_shell_command("cargo check > /dev/null").is_ok());
        assert!(validate_shell_command("npm test > nul 2>&1").is_ok());
        assert!(validate_shell_command("npm test 2>nul").is_ok());
        assert!(validate_shell_command("npm test 2> /dev/null").is_ok());
        assert!(validate_shell_command("npm test 1> nul").is_ok());
        assert!(validate_shell_command("npm test &> /dev/null").is_ok());
        assert!(validate_shell_command("npm test 2>$null").is_ok());
        assert!(validate_shell_command("npm test >$null").is_ok());
        assert!(validate_shell_command("npm test 2> $null").is_ok());
        assert!(validate_shell_command("npm audit --json | ConvertFrom-Json").is_ok());
        assert!(validate_shell_command("npm test > arbitrary_file.txt").is_err());
    }

    #[test]
    fn validate_shell_command_allows_powershell_null_discard_target() {
        assert!(validate_shell_command("npm test 2>$null").is_ok());
        assert!(validate_shell_command("npm test >$null").is_ok());
        assert!(validate_shell_command("npm test 2> $null").is_ok());
        // `$` stays blocked everywhere except as a discard target.
        assert!(validate_shell_command("npm test $null").is_err());
        assert!(validate_shell_command("npm test $(whoami)").is_err());
    }

    #[test]
    fn metacharacter_error_names_a_supported_alternative() {
        match validate_shell_command("if (Test-Path x) { echo y }") {
            Ok(_) => panic!("grouping with parentheses must be rejected"),
            Err(e) => {
                assert!(e.contains("2>$null"), "{e}");
                assert!(e.contains("PTY session"), "{e}");
            }
        }
    }

    /// An escaped quote (odd number of backslashes before it) keeps the quote open,
    /// while an even number of backslashes before a quote closes it, so any
    /// subsequent semicolon is recognized as a segment boundary.
    #[test]
    fn validate_shell_command_counts_backslashes_before_quotes() {
        // Even number of backslashes before a quote closes the quote,
        // so a subsequent semicolon starts a new segment that must be allowlisted.
        assert!(validate_shell_command(r#"cat "file.txt\\"; definitely-not-a-tool"#).is_err());
        assert!(validate_shell_command(r#"cat "file.txt\\"; git status"#).is_ok());

        // Odd number of backslashes before a quote means the quote is escaped
        // and stays open, so semicolons inside remain part of the argument.
        assert!(validate_shell_command(r#"cat "file.txt\"; echo safe""#).is_ok());

        // Escaped quote left unclosed at EOF must be rejected.
        assert!(validate_shell_command(r#"echo foo\"bar""#).is_err());
        assert!(validate_shell_command(r#"echo "foo\"bar"#).is_err());

        // A normal quote pair is still accepted when followed by safe text.
        assert!(validate_shell_command(r#"echo "hello world""#).is_ok());
    }
}

