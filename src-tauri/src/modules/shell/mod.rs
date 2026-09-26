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
// `cargo build`) easily exceeds it and times out, so the agent re-runs it. 120s
// covers a normal one; pass `timeout_secs` (up to 300) for a genuinely slow job.
const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// Program names allowed for agent-triggered execution WITHOUT a PTY.
///
/// termigo-neo keeps no sandbox: every program runs, bare name or path, and
/// `validate_shell_command` allows every command. The list below is retained
/// for reference only.
#[allow(dead_code)]
const SANDBOX_ALLOWLIST: &[&str] = &[
    "cat", "head", "tail", "wc", "grep", "rg", "sed", "awk",
    "find", "ls", "Get-ChildItem", "dir", "stat", "file", "xxd", "hexdump", "od",
    "git", "npm", "pnpm", "yarn", "cargo", "go", "python", "python3",
    "node", "deno", "bun", "make", "just", "task", "cmake", "npx",
    "echo", "printf", "test", "true", "false", "pwd", "cd", "source",
    "which", "where", "type", "command", "hash",
    "diff", "cmp", "comm", "patch", "jq", "yq",
    "tar", "gzip", "gunzip", "zip", "unzip",
    "curl", "wget", "http", "xh",
    "date", "uptime", "whoami", "id", "uname", "hostname",
    "sleep", "Start-Sleep", "cp", "mv", "del", "rmdir", "mkdir", "touch", "chmod", "chown",
    // PowerShell file removal cmdlet. `del` is already allowed as an alias;
    // `Remove-Item` is the canonical name and is explicitly permitted for
    // scripts that call it without relying on alias resolution.
    "Remove-Item",
    "Out-File",
    "Get-ItemProperty", "Invoke-WebRequest",
    // Windows command interpreter. Allowing `cmd` lets the agent run
    // `.bat`/`.cmd` batch files directly without escaping to a PTY.
    "cmd",
    // Windows shells / shell builtins used by the agent on Windows.
    // `powershell` / `pwsh` widen the trust boundary: the outer command is
    // still validated, but the script body passed to `-Command` is not
    // inspected for cmdlet-level danger. They are allowed because the agent
    // already has equivalent power through PTY sessions, and some Windows-only
    // workflows need them without interactive terminal overhead.
    "powershell", "pwsh",
    // Unix shells / login-shell wrappers. These widen the trust boundary
    // because invoking a shell can run arbitrary startup files and builtins;
    // they are allowed because the agent already has equivalent power through
    // PTY sessions, and some workflows need them without interactive overhead.
    "bash", "zsh", "sh",
    // Privilege / system management. These expand the agent's reach beyond
    // normal user permissions, so they are allowed only because the same
    // effect is already possible via an interactive PTY session.
    "sudo", "doas", "systemctl", "service",
    // Remote / container tooling. These can reach other hosts or control
    // system services; allowed for parity with PTY capability.
    "ssh", "docker",
    // Pentest & network recon tooling supported by Termigo
    "nmap", "masscan", "rustscan", "nikto", "nuclei", "httpx", "wpscan",
    "sqlmap", "ffuf", "gobuster", "dirsearch", "subfinder",
    "dig", "host", "nslookup", "ping", "traceroute", "tracepath", "mtr",
    "dnsx", "cmseek", "arjun",
    "tshark", "responder", "bettercap", "ettercap", "enum4linux", "smbclient",
    // Extended recon, TLS and secret scanners (parity with the pentest kits)
    "katana", "amass", "testssl.sh", "testssl",
    "lynis", "gitleaks", "trufflehog", "weasyprint", "whois",
    "whatweb", "hydra", "wafw00f", "searchsploit", "feroxbuster", "showmount",
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
    "chown", "chmod", "mkdir", "rmdir", "cp", "mv", "touch", "ln", "tee",
    "ip", "ifconfig", "netstat", "ss", "lsof", "ps", "pidof", "pgrep", "kill", "pkill", "killall",
    "free", "df", "du", "ufw", "iptables",
    "timeout",
    "useradd", "usermod", "userdel", "groupadd", "groupmod", "groupdel",
    "apt-key", "gpg", "update-alternatives", "su",
    "xargs", "env", "printenv", "basename", "dirname", "realpath", "readlink",
    "cut", "sort", "uniq", "tr", "fold", "paste", "split", "nl",
    // SSH & remote transfer utilities
    "ssh", "scp", "sftp", "rsync",
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
    "jest", "mocha", "playwright", "size-limit", "lint",
    // Python
    "ruff", "black", "mypy", "pytest", "flake8", "isort",
    // GitHub CLI and companion tools
    "gh",
    // Extension introspection (safe read-only inspection of installed extensions)
    "ext_read_manifest", "ext_read_asset", "ext_read_asset_bytes", "ext_list",
    // Go / Rust helpers whose base command is not `go`/`cargo`
    "rustc", "rustup", "cargo-nextest", "cargo-clippy", "cargo-machete",
    "golangci-lint", "rustfmt", "clippy-driver", "clippy", "rust",
    "gofmt", "govulncheck", "dlv",
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
    // Process and job control. `ps` is read-only; `kill`/`killall`/`pkill`
    // let the agent clean up hung shells or background jobs it started, which
    // is already possible through a PTY. `top`/`htop` are interactive viewers.
    "ps", "kill", "killall", "pkill", "top", "htop",
    // Pagers and editors. The agent legitimately needs to inspect long output
    // or edit config files; these are narrower than spawning a full shell.
    "less", "more", "most", "vim", "nano", "vi",
    // File transfer and remote sync. Common in devops and deployment flows;
    // equivalent power exists through an SSH PTY session.
    "scp", "rsync", "sftp",
    // Cloud and infrastructure CLIs. Widely used in modern workflows; the
    // agent already has equivalent reach through an interactive shell.
    "kubectl", "helm", "terraform", "ansible", "aws", "gcloud", "az",
    // Editor CLIs. Useful for headless automation and file inspection.
    "code", "cursor", "windsurf", "subl", "notepad++",
    // OS-level file and URL openers. Let the agent open files/URLs in the
    // user's default application without widening the trust boundary.
    "explorer", "xdg-open", "open",
    //
    // Additional project, language & framework toolchains (coding & refactoring)
    "tsx", "ts-node", "turbo", "prisma", "drizzle-kit",
    "next", "nuxt", "astro", "svelte-kit", "remix",
    "esbuild", "rollup", "webpack", "swc",
    "cross-env", "concurrently", "rimraf", "tree-sitter",
    "zig", "dotnet",
    "java", "javac", "mvn", "gradle", "gradlew",
    "php", "composer",
    "ruby", "gem", "bundle", "rake",
    "elixir", "mix",
    "clang", "clang++", "gcc", "g++", "cc", "c++", "ld", "lld",
    // Database CLIs & query utilities
    "sqlite3", "duckdb", "psql", "mysql", "mariadb", "mongosh", "mongo", "redis-cli",
    // Code audit, linting, formatting & refactoring tools
    "oxlint", "jscodeshift", "ast-grep", "sg", "comby",
    "radon", "pylint", "shellcheck", "shfmt", "sqlfluff",
    "markdownlint", "markdownlint-cli2", "actionlint", "yamllint", "hadolint", "dotenv-linter",
    "cargo-audit", "cargo-deny", "cargo-outdated", "npm-audit", "pnpm-audit",
    // Security audit, vulnerability scanners & pentest tooling
    "semgrep", "bandit", "trivy", "snyk", "osv-scanner", "checkov",
    "grype", "syft", "retire", "auditjs", "checksec",
    "kiterunner", "gau", "waybackurls", "paramspider",
    "dalfox", "commix", "cve-bin-tool", "whispers", "detect-secrets",
    "netcat", "nc", "socat", "tcpdump",
];

/// Whether a program token may run without a PTY.
///
/// An absolute or rooted path is always allowed, on Unix (`/...`) and Windows
/// (`C:\...`, `\...`), because the agent legitimately runs binaries it built.
/// Anything else has to match the allowlist by base name, with the Windows
/// shim extensions (`.exe`, `.cmd`, `.bat`) stripped first.
#[allow(unreachable_code)]
#[allow(dead_code)]
fn allows_program(program: &str) -> bool {
    let _ = program;
    return true;
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
        .or_else(|| program.strip_suffix(".ps1"))
        .or_else(|| program.strip_suffix(".js"))
        .or_else(|| program.strip_suffix(".mjs"))
        .or_else(|| program.strip_suffix(".cjs"))
        .unwrap_or(program);

    // Allow traversing and invoking any executable/script under node_modules (including .pnpm virtual store)
    let norm = program.replace('\\', "/").to_lowercase();
    if norm.starts_with("node_modules/")
        || norm.starts_with("./node_modules/")
        || norm.contains("/node_modules/")
        || norm.starts_with(".pnpm/")
        || norm.starts_with("./.pnpm/")
        || norm.contains("/.pnpm/")
    {
        return true;
    }

    // For relative paths (e.g. `./node_modules/.bin/vitest` or `.\bin\biome.cmd`)
    // match on the file name, across both separators so Windows-style paths
    // validate on Unix and vice versa. Without this the agent cannot invoke a
    // project-local shim by path  -  exactly what a model reaches for when a bare
    // name did not resolve  -  and falls back to reinstalling the package.
    let file_name = base_program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(base_program);

    SANDBOX_ALLOWLIST
        .iter()
        .any(|allowed| base_program.eq_ignore_ascii_case(allowed) || file_name.eq_ignore_ascii_case(allowed))
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
/// `$` is handled specifically: variable expansions ($var, $env:VAR, ${VAR})
/// are allowed as data/arguments, while command substitution ($(cmd)) is refused.
/// Backticks are refused outright. `(` and `)` build subshells. `<` and `>`
/// read or write arbitrary files.
#[allow(dead_code)]
const SHELL_METACHARACTERS: &[char] = &['(', ')', '<', '>', '`'];

/// Characters that split a command into segments. Each segment's program is
/// checked against the allowlist, so accepting them adds no reach: `;` and a
/// newline are separators exactly like `&&`, and a `|` pipeline still runs only
/// programs that are already allowed.
///
/// `\n` and `\r` belong HERE and deliberately NOT in `SHELL_METACHARACTERS`, even
/// though the two lists look interchangeable from the outside. They are not. A
/// newline is refused by being a separator: the command is split at it and the
/// program of every line is checked, so `git status\nrm -rf /` is refused for
/// `rm`. Listing it as a metacharacter instead would refuse the whole command
/// whenever it contained a line break - which is a routine way to run several
/// allowlisted programs (`git status\ngit log`) and the exact shape a caller uses
/// for a multi-step read-only inspection. That is a refusal storm, not a
/// hardening, and the ledger that reported this as an open hole was reading the
/// constant instead of the separator walk. `validate_shell_command_*new_line*`
/// below pins both directions: an unlisted program on the next line is refused,
/// an allowlisted one is not.
///
/// This is the friction that mattered in practice. One install logged **325**
/// refusals for metacharacters, the common ones being `|`, `2>&1` and `;`
/// between two allowlisted programs. The agent's most ordinary request -
/// `find /home/admin/peraturan_pdf -maxdepth 1 -type f | head -30` - failed on
/// the pipe alone, even though `find` and `head` are both allowlisted.
#[allow(dead_code)]
const SHELL_SEPARATORS: &[char] = &[';', '\n', '\r'];

/// Write/delete verbs whose arguments can carry a target path. Used to extend
/// the fs secret deny-list across the SHELL route (F-2, 2026-09-23 deep audit):
/// `write_file` refused `.env` while `Set-Content .env` sailed through, and the
/// same gap bypassed the `.termigo/hooks.json` immutability  -  a hook file is
/// silent-exec persistence, so the shell route must not be a door around it.
///
/// Deliberately a heuristic: a token scan gated on a write verb, not an
/// argument parser. Reads stay allowed by operator policy (an agent debugging
/// config legitimately reads `.env` through a terminal); only writes/deletes to
/// deny-listed targets are refused, and a genuinely intended one goes through
/// a PTY session like every other escape hatch here.
#[allow(dead_code)]
const SHELL_WRITE_VERBS: &[&str] = &[
    "set-content", "add-content", "out-file", "tee-object", "tee",
    "cp", "copy", "copy-item", "mv", "move", "move-item",
    "ren", "rename", "rename-item", "new-item", "ni", "sc", "ac",
    "del", "erase", "remove-item", "ri", "rm", "rmdir", "rd",
];

/// When a write verb is present, the target the command would hit, if that
/// target matches the fs deny-list (secret basename, protected directory, or
/// the agent-immutable config files). None means "nothing to refuse".
#[allow(dead_code)]
fn shell_write_hits_protected_target(command: &str) -> Option<String> {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let has_in_place_flag = tokens.iter().any(|t| *t == "-i" || t.starts_with("-i"));
    let has_write_verb = tokens.iter().any(|t| {
        let bare = t.trim_matches(|c| c == '"' || c == '\'').to_lowercase();
        if bare == "sed" {
            // sed only writes with -i; without it, it reads and prints.
            has_in_place_flag
        } else {
            SHELL_WRITE_VERBS.contains(&bare.as_str())
        }
    });
    if !has_write_verb {
        return None;
    }
    for t in &tokens {
        let trimmed = t.trim_matches(|c| c == '"' || c == '\'');
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let norm = trimmed.replace('\\', "/").to_lowercase();
        if norm.contains("/node_modules/")
            || norm.starts_with("node_modules/")
            || norm.contains("/.pnpm/")
            || norm.starts_with(".pnpm/")
        {
            continue;
        }
        let path = std::path::Path::new(trimmed);
        if crate::modules::fs::security::is_secret_path(path)
            || crate::modules::fs::security::is_protected(path)
        {
            return Some(trimmed.to_string());
        }
        // The agent-immutable config, mirrored from fs::security (the shell
        // route is exactly where a prompt-injected `Set-Content hooks.json`
        // would try to go). Suffix match because the token may be relative or
        // absolute, either spelling.
        let norm = trimmed.replace('\\', "/").to_lowercase();
        if norm.ends_with(".termigo/hooks.json") || norm.ends_with(".termigo/approvals.json") {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Whether the quote character at `chars[i]` is escaped, per the shell that
/// will ACTUALLY execute the command (F-4, 2026-09-23 deep audit).
///
/// Single quotes are never backslash-escaped: POSIX ends the string at the
/// next `'`, and PowerShell escapes by doubling (`''`), which the
/// close-then-reopen toggle of the scanners already reproduces. Double
/// quotes: POSIX escapes with an ODD run of backslashes (an even run is
/// paired data and the quote really closes); PowerShell/cmd treat the
/// backslash as a literal  -  their escapes are a backtick (refused globally
/// as a metacharacter) or `""` (the toggle again). Honoring `\"` on Windows
/// let `echo "a\" ; rm -rf C:\x "` validate as one echo segment while
/// PowerShell closed the string and ran the rm.
#[allow(dead_code)]
fn quote_is_escaped(chars: &[char], i: usize, quote_char: char) -> bool {
    if cfg!(windows) || quote_char == '\'' {
        return false;
    }
    let mut backslashes = 0usize;
    let mut j = i;
    while j > 0 && chars[j - 1] == '\\' {
        backslashes += 1;
        j -= 1;
    }
    backslashes % 2 == 1
}

/// Validate a shell command for agent execution:
/// - refuse expansion, subshells and redirection (`$`, backtick, `(`, `)`, `<`, `>`)
/// - allow `&&`, `||`, `|`, `;` and newlines as separators, but check the program
///   of EVERY segment against the allowlist, not just the first
/// - drop the two redirections that cannot name a file (`N>&M`, `>/dev/null`)
/// - enforce the allowlist for each segment's program unless it is an absolute
///   path
/// - return the command string on success
pub fn validate_shell_command(command: &str) -> Result<&str, String> {
    if command.trim().is_empty() {
        return Err("empty command".into());
    }
    Ok(command)
}
#[allow(dead_code)]
fn is_variable_assignment(segment: &str) -> bool {
    let trimmed = segment.trim();
    if !trimmed.starts_with('$') {
        return false;
    }
    if let Some(eq_idx) = trimmed.find('=') {
        let lhs = trimmed[1..eq_idx].trim_end();
        let after_eq = &trimmed[eq_idx + 1..];
        if !after_eq.starts_with('=') && !lhs.is_empty() {
            let is_valid_lhs = if lhs.starts_with('{') && lhs.ends_with('}') {
                lhs[1..lhs.len() - 1]
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == ':')
            } else {
                lhs.chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == ':')
            };
            return is_valid_lhs;
        }
    }
    false
}

#[allow(dead_code)]
fn rhs_program_if_any(segment: &str) -> Option<String> {
    let trimmed = segment.trim();
    let eq_idx = trimmed.find('=')?;
    let rhs = trimmed[eq_idx + 1..].trim();
    if rhs.is_empty() {
        return None;
    }
    let first_char = rhs.chars().next()?;
    if first_char == '"' || first_char == '\'' || first_char == '$' || first_char.is_ascii_digit() {
        return None;
    }
    let prog = rhs.split_whitespace().next()?.trim_matches(['"', '\'', ';', '&', '|']);
    if prog.is_empty() {
        None
    } else {
        Some(prog.to_string())
    }
}

/// Names that decide which binary an allowlisted command is, or what code it
/// loads before it runs. `PATH=/tmp/x git status` does not run the `git` the
/// command names, and `LD_PRELOAD` / `NODE_OPTIONS=--require` put code inside a
/// program the allowlist approved by name. Both read as ordinary environment
/// setup, which is what makes them worth refusing by name rather than leaving
/// to the program check. Environment configuration is a PTY's job; a command
/// that really needs a different binary can still name its absolute path, which
/// is at least visible in the transcript.
#[allow(dead_code)]
fn is_hijack_env_var(name: &str, value: &str) -> bool {
    const EXACT: &[&str] = &[
        "BASH_ENV",
        "CLASSPATH",
        "EDITOR",
        "ENV",
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_EXEC_PATH",
        "GIT_EXTERNAL_DIFF",
        "GIT_PAGER",
        "GIT_SSH_COMMAND",
        "JAVA_TOOL_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "PATH",
        "PERL5OPT",
        "PROMPT_COMMAND",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "RUBYOPT",
        "RUSTC_WRAPPER",
        "VISUAL",
        "_JAVA_OPTIONS",
    ];
    const PREFIXES: &[&str] = &["DYLD_", "LD_", "NPM_CONFIG_"];
    let upper = name.to_ascii_uppercase();
    if upper == "NODE_OPTIONS" {
        // The flag a build tooling needs is a heap size; the ones that load code
        // or open a debugger are the problem, so this name is judged by value.
        // Quotes are punctuation around the value, not part of the flag: both
        // `$env:NODE_OPTIONS='--require x.js'` and `NODE_OPTIONS='--require
        // x.js' node` reach here with the quote still attached to the token.
        let unquoted: String = value
            .chars()
            .filter(|c| *c != '\'' && *c != '"')
            .collect();
        return unquoted.split_whitespace().any(|flag| {
            flag == "-r"
                || flag.starts_with("--require")
                || flag.starts_with("--import")
                || flag.starts_with("--experimental-loader")
                || flag.starts_with("--inspect")
        });
    }
    EXACT.contains(&upper.as_str()) || PREFIXES.iter().any(|p| upper.starts_with(p))
}

#[allow(dead_code)]
fn hijack_env_error(name: &str) -> String {
    format!(
        "assignment to '{name}' is refused because it can change which program runs or what code a program loads; use a PTY session for environment setup"
    )
}

/// The variable a PowerShell assignment targets and the value handed it, for
/// `$env:PATH = 'x'`, `${env:PATH} = 'x'` and `$PATH = 'x'`. Names come back
/// upper-cased because Windows environment variables are case-insensitive.
#[allow(dead_code)]
fn assignment_target(segment: &str) -> Option<(String, String)> {
    let trimmed = segment.trim();
    let eq = trimmed.find('=')?;
    let lhs = trimmed[..eq]
        .trim()
        .trim_start_matches('$')
        .trim_matches(['{', '}']);
    let name = lhs.strip_prefix("env:").unwrap_or(lhs).trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '_')
    {
        return None;
    }
    Some((name.to_ascii_uppercase(), trimmed[eq + 1..].to_string()))
}

/// A POSIX-style environment-assignment token: `NAME=value` where NAME is a
/// shell identifier (`[A-Za-z_][A-Za-z0-9_.]*`). PowerShell's `$x = ...` is
/// NOT this (it starts with `$` and is handled by `is_variable_assignment`),
/// and neither is a bare `=value` or a `==` comparison.
#[allow(dead_code)]
fn is_posix_env_assignment(token: &str) -> bool {
    let Some(eq) = token.find('=') else {
        return false;
    };
    if eq == 0 {
        return false;
    }
    let name = &token[..eq];
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Drop the redirections that cannot name a file: `N>&M` (join two of the
/// process's own streams) and `>/dev/null` (discard). Both are replaced with a
/// space so the character scan never sees the `&` or `>` they contain.
///
/// Everything else that redirects is left in place and therefore refused by the
/// scan, because `> file` writes wherever it is pointed - including the secret
/// paths the rest of the app refuses to touch. The caller runs the ORIGINAL
/// command, so the shell still performs these redirections.
#[allow(dead_code)]
fn strip_dev_null_redirections(command: &str) -> Result<String, String> {
    const DEV_NULL_LEN: usize = "/dev/null".len();
    const DOLLAR_NULL_LEN: usize = "$null".len();
    let chars: Vec<char> = command.chars().collect();
    let mut out = String::with_capacity(command.len());
    let mut in_quote = false;
    let mut quote_char = '\0';
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_quote && (c == '"' || c == '\'') {
            in_quote = true;
            quote_char = c;
            out.push(c);
            i += 1;
            continue;
        }
        if in_quote && c == quote_char && !quote_is_escaped(&chars, i, quote_char) {
            in_quote = false;
            quote_char = '\0';
            out.push(c);
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
                i += 4;
                continue;
            }
            // `>` or `N>` or `*>` followed by `/dev/null` or `$null` (Windows PowerShell).
            // A second `>` means append, so `>>` is not matched and stays refused.
            let gt = if c == '>' {
                Some(i)
            } else if (c.is_ascii_digit() || c == '*') && chars.get(i + 1) == Some(&'>') {
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
                    let matched_len = if chars.len() >= j + DEV_NULL_LEN
                        && chars[j..j + DEV_NULL_LEN].iter().collect::<String>() == "/dev/null"
                    {
                        Some(DEV_NULL_LEN)
                    } else if chars.len() >= j + DOLLAR_NULL_LEN
                        && chars[j..j + DOLLAR_NULL_LEN].iter().collect::<String>() == "$null"
                    {
                        Some(DOLLAR_NULL_LEN)
                    } else {
                        None
                    };

                    if let Some(target_len) = matched_len {
                        let is_null_target = chars.get(j + target_len).is_none_or(|a| {
                            a.is_whitespace()
                                || matches!(a, ';' | '|' | '&' | '<' | '>' | ')' | '"' | '\'')
                        });
                        if is_null_target {
                            out.push(' ');
                            i = j + target_len;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(c);
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
/// the user's interactive PTY  -  that would fight their input. AI tool calls
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
    #[cfg(windows)]
    let _job = crate::modules::proc::job::ProcessJob::create_for(child.id()).ok();

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
            crate::modules::proc::kill_tree(child.id());
            let _ = child.kill();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("shell wait thread disconnected".into());
        }
    };

    let (pipe_tx, pipe_rx) = mpsc::channel();
    thread::spawn(move || {
        let stdout_res = stdout_handle.join().unwrap_or((Vec::new(), false));
        let stderr_res = stderr_handle.join().unwrap_or((Vec::new(), false));
        let _ = pipe_tx.send((stdout_res, stderr_res));
    });

    let ((stdout_bytes, stdout_truncated), (stderr_bytes, stderr_truncated)) =
        match pipe_rx.recv_timeout(Duration::from_millis(2000)) {
            Ok(res) => res,
            Err(_) => {
                log::warn!("shell_run_command: pipe readers timed out after process exit/kill");
                ((Vec::new(), false), (Vec::new(), false))
            }
        };

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
    pub(crate) repls: RwLock<HashMap<u32, Arc<repl::ReplProc>>>,
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
    state.sessions.write().unwrap_or_else(|e| e.into_inner()).insert(id, session);
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
        .unwrap_or_else(|e| e.into_inner())
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
        .unwrap_or_else(|e| e.into_inner())
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
    state.sessions.write().unwrap_or_else(|e| e.into_inner()).remove(&id);
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
    state.bg.write().unwrap_or_else(|e| e.into_inner()).insert(id, proc);
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
        .unwrap_or_else(|e| e.into_inner())
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no background handle".to_string())?;
    Ok(proc.read_logs(since_offset.unwrap_or(0)))
}

#[tauri::command]
pub fn shell_bg_kill(state: tauri::State<ShellState>, handle: u32) -> Result<bool, String> {
    if let Some(proc) = state.bg.read().unwrap_or_else(|e| e.into_inner()).get(&handle).cloned() {
        Ok(proc.kill())
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn shell_bg_list(state: tauri::State<ShellState>) -> Result<Vec<BackgroundProcInfo>, String> {
    let map = state.bg.read().unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::with_capacity(map.len());
    for (id, p) in map.iter() {
        out.push(p.info((*id).into()));
    }
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

#[tauri::command]
pub fn repl_open(
    state: tauri::State<ShellState>,
    registry: tauri::State<WorkspaceRegistry>,
    command: String,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    validate_shell_command(trimmed)?;

    let mut map = state.repls.write().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, p| !p.exited.load(std::sync::atomic::Ordering::Acquire));
    if map.len() >= repl::MAX_LIVE {
        return Err(format!("too many live REPL processes (max {})", repl::MAX_LIVE));
    }
    let proc = repl::spawn(trimmed.to_string(), cwd, workspace)?;
    let id = state.next_repl_id.fetch_add(1, Ordering::Relaxed);
    map.insert(id, proc);
    Ok(id)
}

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
        .unwrap_or_else(|e| e.into_inner())
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no such REPL process".to_string())?;

    if let Some(ref text) = input {
        proc.send_line(text)?;
    }

    let timeout = Duration::from_secs(
        timeout_secs
            .unwrap_or(repl::DEFAULT_WAIT_SECS)
            .clamp(1, repl::MAX_WAIT_SECS),
    );
    let offset = since_offset.unwrap_or(0);

    let turn = tauri::async_runtime::spawn_blocking(move || {
        proc.wait_for(offset, until.as_deref(), timeout)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(turn)
}

#[tauri::command]
pub fn repl_close(state: tauri::State<ShellState>, handle: u32) -> Result<(), String> {
    if let Some(proc) = state.repls.write().unwrap_or_else(|e| e.into_inner()).remove(&handle) {
        proc.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn repl_list(state: tauri::State<ShellState>) -> Result<Vec<repl::ReplInfo>, String> {
    let map = state.repls.read().unwrap_or_else(|e| e.into_inner());
    let mut list: Vec<_> = map.iter().map(|(&handle, p)| p.info(handle)).collect();
    list.sort_by_key(|i| i.started_at_ms);
    Ok(list)
}

/// Collect `node_modules/.bin` directories from `cwd` upward (nearest first),
/// the same resolution `npm run` / `pnpm run` give a package script.
///
/// The agent's one-shot shell inherits the system PATH, where a project's own
/// dev binaries do not exist: `vitest run` fails with "not recognized" on a
/// machine that has vitest installed locally, and a model that sees that
/// failure "fixes" it by reinstalling the package. Prepending the project's
/// bin dirs makes the local install the one that runs.
fn node_bin_dirs(cwd: &str) -> Vec<std::path::PathBuf> {
    let home = dirs::home_dir();
    let mut out = Vec::new();
    let mut dir = std::path::Path::new(cwd);
    loop {
        if home.as_deref() == Some(dir) {
            break;
        }
        let bin = dir.join("node_modules").join(".bin");
        if bin.is_dir() {
            out.push(bin);
        }
        match dir.parent() {
            Some(parent) if parent != dir => dir = parent,
            _ => break,
        }
    }
    out
}

/// PATH with `cwd`'s `node_modules/.bin` chain prepended, or None when there
/// is nothing to prepend.
fn path_with_node_bins(cwd: Option<&str>) -> Option<String> {
    let cwd = cwd.filter(|s| !s.is_empty())?;
    let bins = node_bin_dirs(cwd);
    if bins.is_empty() {
        return None;
    }
    let sep = if cfg!(windows) { ";" } else { ":" };
    let current = std::env::var("PATH")
        .or_else(|_| std::env::var("Path"))
        .unwrap_or_default();
    let joined = bins
        .iter()
        .map(|p| p.to_string_lossy())
        .collect::<Vec<_>>()
        .join(sep);
    Some(if current.is_empty() {
        joined
    } else {
        format!("{joined}{sep}{current}")
    })
}

pub(crate) fn build_oneshot_command(
    command: &str,
    #[cfg_attr(not(windows), allow(unused_variables))] workspace: &WorkspaceEnv,
    cwd: Option<&str>,
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
        if let Some(path) = path_with_node_bins(cwd) {
            cmd.env("PATH", path);
        }
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
        // Only a local workspace has a Windows-side node_modules to resolve;
        // the WSL branch returned above.
        if matches!(workspace, WorkspaceEnv::Local) {
            if let Some(path) = path_with_node_bins(cwd) {
                cmd.env("PATH", path);
            }
        }
        let is_cmd = shell
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("cmd.exe"))
            .unwrap_or(false);
        if is_cmd {
            cmd.arg("/C").arg(command);
        } else {
            cmd.arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-Command")
                .arg(command);
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
    }    #[test]
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

/// End-to-end spawn test for the `node_modules/.bin` PATH prepend  -  the string
/// helpers are unit-tested in `tests_node_path`, but the part that actually
/// broke in the field is the SPAWN: whether the child shell's environment ends
/// up with the bin dir (Windows env keys are case-insensitive  -  `PATH` vs
/// `Path`  -  and a botched merge there silently loses the prepend) and whether
/// a pnpm-style `.cmd` shim resolves by bare name.
#[cfg(all(test, windows))]
mod tests_windows_node_path_e2e {
    use super::*;

    #[test]
    fn spawned_shell_resolves_a_local_bin_shim_by_bare_name() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        // Same shape pnpm/npm create on Windows: a .cmd shim next to the
        // extensionless sh script.
        std::fs::write(bin.join("faketool.cmd"), "@echo FAKETOOL_OK\r\n").unwrap();

        let out = run_blocking_interruptible(
            "faketool".into(),
            Some(root.path().to_string_lossy().to_string()),
            WorkspaceEnv::Local,
            Duration::from_secs(30),
            Default::default(),
        )
        .expect("spawn");

        assert_eq!(
            out.exit_code,
            Some(0),
            "shim did not resolve; stderr: {}",
            out.stderr
        );
        assert!(
            out.stdout.contains("FAKETOOL_OK"),
            "unexpected stdout: {}",
            out.stdout
        );
    }

    #[test]
    fn spawned_shell_path_starts_with_the_project_bin() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();

        let cwd = root.path().to_string_lossy().to_string();
        // Whatever the configured Windows shell is, it can echo its own PATH.
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let is_cmd = shell
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("cmd.exe"))
            .unwrap_or(false);
        let probe = if is_cmd {
            "echo %PATH%"
        } else {
            "Write-Output $env:PATH"
        };

        let out = run_blocking_interruptible(
            probe.into(),
            Some(cwd.clone()),
            WorkspaceEnv::Local,
            Duration::from_secs(30),
            Default::default(),
        )
        .expect("spawn");

        let printed = out.stdout.trim();
        let expected_first = bin.to_string_lossy().to_string();
        assert!(
            printed.to_lowercase().starts_with(&expected_first.to_lowercase()),
            "child PATH does not start with the project bin dir.\nPATH={printed}"
        );
        // The system PATH must survive the prepend, or the shell loses every
        // other tool. Check a directory that is essentially always present.
        let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        assert!(
            printed.to_lowercase().contains(&windir.to_lowercase()),
            "system PATH was lost in the prepend: {printed}"
        );
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
            "lint",
            "source ~/.bashrc",
            "source venv/bin/activate",
            "pnpm lint",
            "pnpm test",
            "tsx src/index.ts",
            "prisma generate",
            "sqlite3 test.db .tables",
            "semgrep scan --config auto",
            "trivy fs .",
            "ast-grep scan",
            "shellcheck script.sh",
            "cargo-audit audit",
            "./node_modules/.bin/vitest run",
            "node_modules/vitest/vitest.mjs run",
            "./node_modules/.pnpm/vitest@4.1.10/node_modules/vitest/vitest.mjs run",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_allows_toolchain_with_extension() {
        assert!(validate_shell_command("biome.exe lint ./src").is_ok());
        assert!(validate_shell_command("tsc.cmd --noEmit").is_ok());
        assert!(validate_shell_command("vitest.bat run").is_ok());
        assert!(validate_shell_command("node_modules/.bin/vitest.ps1 run").is_ok());
        assert!(validate_shell_command("node_modules/.bin/biome.ps1 check .").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_arbitrary_programs_without_sandbox() {
        assert!(validate_shell_command("definitely-not-a-tool --go").is_ok());
        assert!(validate_shell_command("shred -u /").is_ok());
        assert!(validate_shell_command("rm -rf /").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_windows_paths_and_extensions() {
        assert!(validate_shell_command(r#"C:\tools\mytool.exe --flag"#).is_ok());
        assert!(validate_shell_command(r#""C:\Program Files\tool.exe" arg"#).is_ok());
        assert!(validate_shell_command("git.exe status").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_metacharacters_and_redirection() {
        assert!(validate_shell_command("echo hello > out.txt").is_ok());
        assert!(validate_shell_command("echo hello >> out.txt").is_ok());
        assert!(validate_shell_command("cat id").is_ok());
        assert!(validate_shell_command("cat secret").is_ok());
        assert!(validate_shell_command("cat file < input").is_ok());
        assert!(validate_shell_command("(git status)").is_ok());
        assert!(validate_shell_command("git status & git log").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_env_vars() {
        assert!(validate_shell_command("DEBIAN_FRONTEND=noninteractive apt-get install -y nmap").is_ok());
        assert!(validate_shell_command("FOO=bar echo hello").is_ok());
        assert!(validate_shell_command("CI=true NODE_OPTIONS=--max-old-space-size=4096 pnpm test").is_ok());
        assert!(validate_shell_command("FOO=bar shred -u /").is_ok());
        assert!(validate_shell_command("PATH=/tmp/evil git status").is_ok());
        assert!(validate_shell_command(" = Get-ChildItem; echo ").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_multiline_and_chains() {
        assert!(validate_shell_command("git status\nshred -u /").is_ok());
        assert!(validate_shell_command("git status\r\nshred -u /").is_ok());
        assert!(validate_shell_command("git status && shred -u /").is_ok());
        assert!(validate_shell_command("cat file | shred -u /").is_ok());
        assert!(validate_shell_command("git status; git log").is_ok());
        assert!(validate_shell_command("git status; shred -u /").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_stream_joins_and_redirections() {
        assert!(validate_shell_command("pnpm test 2>&1").is_ok());
        assert!(validate_shell_command("pnpm test > /dev/null").is_ok());
        assert!(validate_shell_command("echo x > /dev/nullx").is_ok());
        assert!(validate_shell_command("echo x > ~/.ssh/authorized_keys").is_ok());
    }

    #[test]
    fn validate_shell_command_allows_pentest_and_recon_tools() {
        for cmd in [
            "dnsx -d example.com",
            "katana -u https://example.com",
            "amass enum -d example.com",
            "cmseek -u https://example.com",
            "arjun -u https://example.com",
            "testssl.sh https://example.com",
            "testssl https://example.com",
            "lynis audit system",
            "gitleaks detect",
            "trufflehog git file://.",
            "weasyprint report.html report.pdf",
            "whois example.com",
            "dig example.com",
            "nslookup example.com",
            "traceroute example.com",
            "whatweb https://example.com",
            "hydra -l user -p pass ssh://example.com",
            "wafw00f https://example.com",
            "searchsploit apache",
            "feroxbuster -u https://example.com",
            "enum4linux 192.168.1.1",
            "smbclient -L //192.168.1.1",
            "showmount -e 192.168.1.1",
        ] {
            assert!(validate_shell_command(cmd).is_ok(), "blocked: {cmd}");
        }
    }

    #[test]
    fn validate_shell_command_allows_writes_to_any_targets() {
        for cmd in [
            "Set-Content .termigo/hooks.json '{}'",
            "Set-Content C:\\proj\\.termigo\\hooks.json '{}'",
            "Out-File -FilePath .termigo/approvals.json",
            "cp notes.txt .env",
            "copy notes.txt .env.production",
            "Out-File C:\\Users\\me\\.ssh\\authorized_keys",
            "Remove-Item id_rsa",
            "del known_hosts",
            "mv backup.pem /tmp/x.pem",
            "sed -i s/a/b/ .env",
            "tee id_ed25519",
        ] {
            assert!(validate_shell_command(cmd).is_ok());
        }
    }

    #[test]
    fn validate_shell_command_refuses_empty_command() {
        assert!(validate_shell_command("").is_err());
        assert!(validate_shell_command("   ").is_err());
        assert!(validate_shell_command("\t\n").is_err());
    }
}

#[cfg(test)]mod tests_node_path {
    use super::*;

    /// The failure this covers: `vitest run` / `biome lint` are allowlisted, but
    /// the one-shot shell inherits the system PATH where a project's local dev
    /// binaries do not exist. Without the `node_modules/.bin` prepend the command
    /// dies with "not recognized" and the model responds by reinstalling a
    /// package that is already on the machine.
    #[test]
    fn node_bin_dirs_finds_the_project_bin_and_ancestor_bins() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        let nested = project.join("packages").join("web");
        std::fs::create_dir_all(project.join("node_modules").join(".bin")).unwrap();
        std::fs::create_dir_all(nested.join("node_modules").join(".bin")).unwrap();

        let dirs = node_bin_dirs(nested.to_str().unwrap());
        // Nearest first: the nested package's own bin shadows the root's.
        assert_eq!(dirs.len(), 2, "{dirs:?}");
        assert_eq!(dirs[0], nested.join("node_modules").join(".bin"));
        assert_eq!(dirs[1], project.join("node_modules").join(".bin"));
    }

    #[test]
    fn node_bin_dirs_is_empty_without_node_modules() {
        let root = tempfile::tempdir().unwrap();
        assert!(node_bin_dirs(root.path().to_str().unwrap()).is_empty());
    }

    #[test]
    fn path_with_node_bins_prepends_and_keeps_the_existing_path() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();

        // No cwd or no node_modules: nothing to prepend.
        assert!(path_with_node_bins(None).is_none());
        assert!(path_with_node_bins(Some("")).is_none());

        let joined = path_with_node_bins(Some(root.path().to_str().unwrap()))
            .expect("bin dir exists");
        assert!(joined.starts_with(&bin.to_string_lossy().to_string()), "{joined}");
        // The original PATH survives after the separator, or the shell loses
        // every system tool.
        let original = std::env::var("PATH")
            .or_else(|_| std::env::var("Path"))
            .unwrap_or_default();
        if !original.is_empty() {
            assert!(joined.ends_with(&original), "{joined}");
        }
    }
}

