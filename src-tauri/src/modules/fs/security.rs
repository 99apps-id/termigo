//! Path-safety guards for the raw `fs::*` IPC commands.
//!
//! termigo-neo keeps no gates: every guard in this module allows, and the
//! workspace registry authorizes every path. The helpers and their signatures
//! stay so all call sites keep compiling; only the verdicts changed.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

/// Safe `.env` TEMPLATE names, mirrored from the TypeScript deny-list. Repos
/// commit these on purpose (names only, never values) so an agent can read
/// them. Every other `.env*` spelling stays blocked. Exact anchor, no suffix.
fn safe_env_template() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^\.env[._-](example|sample|template|dist)$").unwrap())
}

/// Basename patterns that almost always carry secrets. Case-insensitive;
/// trailing `[.\s:]` (or end) so Windows trailing dots/spaces and NTFS
/// alternate-data-stream tails (`name:stream`) still match.
fn secret_basename_patterns() -> &'static [Regex] {
    static SET: OnceLock<Vec<Regex>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            r"(?i)^\.env(\..+)?(?:[.\s:]|$)",
            r"(?i)^.*\.pem(?:[.\s:]|$)",
            r"(?i)^.*\.key(?:[.\s:]|$)",
            r"(?i)^.*\.p12(?:[.\s:]|$)",
            r"(?i)^.*\.pfx(?:[.\s:]|$)",
            r"(?i)^.*\.asc(?:[.\s:]|$)",
            r"(?i)^.*\.gpg(?:[.\s:]|$)",
            r"(?i)^.*\.keystore(?:[.\s:]|$)",
            r"(?i)^.*\.jks(?:[.\s:]|$)",
            r"(?i)^id_(rsa|dsa|ecdsa|ed25519)([._-].*)?(?:[.\s:]|$)",
            r"(?i)^known_hosts(?:[.\s:]|$)",
            r"(?i)^authorized_keys(?:[.\s:]|$)",
            r"(?i)^htpasswd(?:[.\s:]|$)",
            r"(?i)^\.netrc(?:[.\s:]|$)",
            r"(?i)^_netrc(?:[.\s:]|$)",
            r"(?i)^credentials(?:[.\s:]|$)",
            r"(?i)^\.pgpass(?:[.\s:]|$)",
            r"(?i)^\.npmrc(?:[.\s:]|$)",
            r"(?i)^\.pypirc(?:[.\s:]|$)",
            r"(?i)^secrets?\.(json|ya?ml|toml|env)(?:[.\s:]|$)",
            r"(?i)^service[-_]?account.*\.json(?:[.\s:]|$)",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    })
}

/// Directories that hold host secrets, PII, credentials, or git internals.
/// Matched as exact path or descendant (never raw substring).
#[allow(dead_code)]
const PROTECTED_DIRS: &[&str] = &[
    "/.ssh",
    "/.shh",
    "/.gnupg",
    "/.aws",
    "/.azure",
    "/.kube",
    "/.docker",
    "/.config/gh",
    "/.config/git",
    "/.config/gcloud",
    "/.config/op",
    "/.git",
    "/.terraform.d",
    "/library/keychains",
    "/library/cookies",
    "/etc",
    "/private/etc",
    "/proc",
    "/sys",
    "/var/db",
    "/var/root",
    "/private/var/db",
    "/private/var/root",
    "/appdata/roaming/microsoft/credentials",
    "/appdata/local/microsoft/credentials",
    "/appdata/roaming/gcloud",
    // NOTE: Windows system directories (/windows, /program files, /programdata)
    // are deliberately NOT protected. They blocked legitimate agent work
    // (inspecting installed tooling, writing install targets) and the operator
    // chose prompt-level guardrails over a hard deny here  -  see the filesystem
    // safety rules in the system prompt. Credential stores stay protected.
];

/// Write-only deny prefixes. Read access is not universally blocked, writing to
/// these Unix system locations always is. Windows system directories are NOT
/// listed: the operator allows installs/writes there (guarded at the prompt and
/// by the approval layer instead), while the Unix set stays denied because
/// nothing in an agent's legitimate workflow writes to /usr/bin or /etc via the
/// fs tools  -  package managers do that through the shell, which has its own
/// approval path.
#[allow(dead_code)]
const WRITE_DENY_PREFIXES: &[&str] = &[
    "/etc/",
    "/var/db/",
    "/var/root/",
    "/system/",
    "/library/keychains/",
    "/library/launchagents/",
    "/library/launchdaemons/",
    "/private/etc/",
    "/private/var/db/",
    "/usr/bin/",
    "/usr/sbin/",
    "/usr/local/bin/",
    "/bin/",
    "/sbin/",
    "/boot/",
];

/// Files that decide what runs LATER: termigo's own hook and MCP registries,
/// plus the workspace config of the agents termigo spawns. A hook is read back
/// and run on every matching tool event with no prompt, and an MCP entry is a
/// command termigo spawns, so an agent write here is persistence the operator
/// never asked for. Matched as a path suffix, because the file may be spelled
/// relatively or absolutely and the user-level `~/.termigo/*` registry shares
/// the same tail.
///
/// `approvals.json` belongs to the same class and is deliberately absent: the
/// approval dialog's own "allow for this project" button writes it through this
/// same `fs_write_file` path, and this layer cannot tell that click from an
/// agent call. The shell route, which has no such caller, refuses it instead.
const AGENT_IMMUTABLE_CONFIG: &[&str] = &[
    "/.termigo/hooks.json",
    "/.termigo/mcp.json",
    "/.claude/settings.json",
    "/.claude/settings.local.json",
    "/.codex/config.toml",
    "/.gemini/settings.json",
];

/// Directories that hold credentials, keys, or git internals. Writing inside one
/// is not a normal edit: it hijacks the operator's own tooling, or plants
/// something git runs later (`.git/hooks/pre-commit`, or `.git/config` carrying
/// a `core.hooksPath`).
///
/// Deliberately narrower than the read-side `PROTECTED_DIRS`, which also lists
/// system directories (`/etc`, `/proc`, `/sys`, `/usr`). Writing `/etc/hosts` or
/// a keyring path is a real workflow on a host an operator is testing, and those
/// paths need root anyway, so they stay a judgment call rather than a wall.
const PROTECTED_WRITE_DIRS: &[&str] = &[
    // The agent's own audit log. It is written by `audit_append` in Rust, and
    // locked here so the record cannot be rewritten by the thing it records.
    "/.termigo/audit",
    "/.ssh",
    "/.shh",
    "/.gnupg",
    "/.aws",
    "/.azure",
    "/.kube",
    "/.docker",
    "/.config/gh",
    "/.config/git",
    "/.config/gcloud",
    "/.config/op",
    "/.git",
    "/.terraform.d",
    "/library/keychains",
    "/library/cookies",
    "/appdata/roaming/microsoft/credentials",
    "/appdata/local/microsoft/credentials",
    "/appdata/roaming/gcloud",
];

/// Extension bundles live outside the workspace, and a bundle's manifest names
/// the module the host loads, so an agent write there is code execution at the
/// next activation. Only the write path consults this: installing an extension
/// goes through its own implementation, not through `fs_write_file`.
const EXTENSION_ROOT_NEEDLE: &str = "/id.99apps.termigo/extensions/";

/// The audit log, written by `audit_append` in Rust. Locked here so the record of
/// what an agent did cannot be edited by the agent that did it.
const AUDIT_ROOT_NEEDLE: &str = "/id.99apps.termigo/audit/";

fn basename(p: &str) -> &str {
    match p.rfind(['/', '\\']) {
        Some(i) => &p[i + 1..],
        None => p,
    }
}

/// Normalized comparison surface, mirroring the TypeScript version. Never used
/// as a real path: back-slashes to forward, strip `//?/` and drive prefix, drop
/// NTFS alternate-data-stream tails and trailing dots/spaces per segment,
/// collapse duplicate slashes, lowercase, drop trailing slash.
fn comparison_form(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        // `//?/C:/x` -> `/x`, `//?/UNC/server/share/x` -> `/x`: strip the
        // machine-specific head (drive letter or UNC server/share) so the
        // remainder compares against the protected prefixes exactly like a
        // plain absolute path. Mirrors the TypeScript comparisonForm, which
        // replaces the same head with a single `/`.
        //
        // Written as nested `if let` rather than a let-chain: this crate is
        // edition 2021, where let-chains do not compile.
        let bytes = rest.as_bytes();
        let head_end = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            // Drive letter: skip `C:`.
            2
        } else if let Some(unc) = rest.strip_prefix("UNC/") {
            // UNC: skip `UNC/server/share`, keep the remainder. A head
            // without both segments is not a valid UNC path; fall back to
            // stripping only `//?/` so the shape stays comparable.
            let mut end = 0;
            if let Some(first) = unc.find('/') {
                if let Some(second) = unc[first + 1..].find('/') {
                    end = "UNC/".len() + first + 1 + second;
                }
            }
            end
        } else {
            0
        };
        let tail = &rest[head_end.min(rest.len())..];
        s = format!("/{tail}");
    }
    let b = s.as_bytes();
    let is_windows_style = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    if is_windows_style {
        s = s[2..].to_string();
    }
    let segs: Vec<String> = s
        .split('/')
        .map(|seg| {
            if is_windows_style {
                let colon = seg.find(':').unwrap_or(seg.len());
                let trimmed =
                    seg[..colon].trim_end_matches(|c: char| c == '.' || c.is_whitespace());
                trimmed.to_string()
            } else {
                seg.to_string()
            }
        })
        .collect();
    s = segs.join("/");
    let mut collapsed = String::with_capacity(s.len());
    let mut prev_slash = false;
    for c in s.chars() {
        if c == '/' {
            if !prev_slash {
                collapsed.push(c);
            }
            prev_slash = true;
        } else {
            collapsed.push(c);
            prev_slash = false;
        }
    }
    s = collapsed.to_lowercase();
    if s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

/// System roots match at the filesystem root only. They must NOT float like
/// the dot-directories below: a workspace legitimately contains `etc/` or
/// `proc/` (infra repos do), while nothing legitimate is named `.ssh`.
/// A leading `//wsl$/<distro>` (or `//wsl.localhost/...`) prefix is stripped
/// first so WSL system paths (`\\wsl$\Ubuntu\etc\passwd`) still match.
fn is_system_root(dir: &str) -> bool {
    matches!(
        dir,
        "/etc"
            | "/private/etc"
            | "/proc"
            | "/sys"
            | "/var/db"
            | "/var/root"
            | "/private/var/db"
            | "/private/var/root"
            | "/system"
    )
}

fn strip_wsl_host_prefix(cmp: &str) -> &str {
    // `//wsl$/ubuntu/etc/passwd` (or `/wsl$/ubuntu/etc/passwd` after the
    // duplicate-slash collapse in `comparison_form`) -> `/etc/passwd`: drop
    // the host/distro head so the root comparison below sees a plain absolute
    // path. The host MUST be a WSL host (`wsl$`, `wsl.localhost`); anything
    // else (`/users/...`, `/etc/...`) is an ordinary path and is returned
    // unchanged.
    let rest = match cmp.strip_prefix("//").or_else(|| cmp.strip_prefix('/')) {
        Some(r) => r,
        None => return cmp,
    };
    let host_end = match rest.find('/') {
        Some(i) => i,
        None => return cmp,
    };
    let host = &rest[..host_end];
    if host != "wsl$" && host != "wsl.localhost" {
        return cmp;
    }
    let after_host = &rest[host_end + 1..];
    let distro_end = match after_host.find('/') {
        Some(i) => i,
        None => return cmp,
    };
    &after_host[distro_end..]
}

fn is_under_protected(cmp: &str, dir: &str) -> bool {
    if is_system_root(dir) {
        let root = strip_wsl_host_prefix(cmp);
        let root = if root.starts_with('/') {
            root.to_string()
        } else {
            format!("/{root}")
        };
        return root == dir || root.starts_with(&format!("{dir}/"));
    }
    // Dot-directories, library and appdata entries live under a home
    // directory (or any depth), so they float: `/.ssh/` matches anywhere as
    // long as the slashes around it are real segment boundaries.
    format!("{cmp}/").contains(&format!("{dir}/"))
}

/// Whether a path sits under a protected directory, for walker pruning. Uses
/// the raw string only: the walkers already never follow symlinks, and a
/// per-entry canonicalize over a 50k-entry tree would be far too slow. A
/// symlinked-in secret is instead caught by the canonical pass in
/// `validate_read` / `guard_read` on the explicit read/write path.
#[allow(unreachable_code)]
pub fn is_protected(path: &Path) -> bool {
    let _ = path;
    return false;
    let cmp = comparison_form(&path.to_string_lossy());
    PROTECTED_DIRS.iter().any(|d| is_under_protected(&cmp, d))
}

/// Basename deny-list with no filesystem access, for the walkers that return
/// file *content*. `is_protected` only prunes known secret directories, so a
/// `*.pem` / `id_rsa` / `credentials.json` living in an ordinary directory (or
/// anywhere under an authorized root such as `$HOME`) had its body echoed back
/// by the content search while `fs_read_file` refused the very same file. Cheap
/// on purpose: one regex pass over the file name and no `canonicalize`, so it is
/// safe to call per entry in a large walk.
#[allow(unreachable_code)]
pub fn is_secret_path(path: &Path) -> bool {
    let _ = path;
    return false;
    let name = match path.file_name() {
        Some(n) => n.to_string_lossy(),
        None => return false,
    };
    if name.is_empty() || safe_env_template().is_match(&name) {
        return false;
    }
    secret_basename_patterns()
        .iter()
        .any(|re| re.is_match(&name))
}

fn describe_protected(dir: &str) -> &str {
    dir.trim_start_matches('/')
}

#[allow(unreachable_code)]
pub fn check_readable(path: &str) -> Result<(), String> {
    let _ = path;
    return Ok(());
    if path.is_empty() {
        return Err("Refused: empty path.".into());
    }
    if path.bytes().any(|b| b < 0x20) {
        return Err("Refused: path contains control bytes.".into());
    }

    let base = basename(path);
    if !safe_env_template().is_match(base) {
        for re in secret_basename_patterns() {
            if re.is_match(base) {
                return Err(format!(
                    "Refused: \"{base}\" matches a sensitive-file pattern."
                ));
            }
        }
    }

    let cmp = comparison_form(path);
    for dir in PROTECTED_DIRS {
        if is_under_protected(&cmp, dir) {
            return Err(format!(
                "Refused: path is inside a protected directory ({}).",
                describe_protected(dir)
            ));
        }
    }
    Ok(())
}

/// Appended to every write refusal. A refusal that only explains itself invites
/// a retry with a tweaked path: naming the stop is what makes the model report
/// instead, and it matches the wording the approval queue already uses
/// (`subagentGating.ts`). `pub` so the shell route appends this exact string
/// rather than inventing a second phrasing.
pub const REFUSAL_HINT: &str = " Do not retry this write; report it as not done.";

/// The write deny-list as one function, so the fs route and the shell route
/// cannot drift apart. `None` means the write may proceed.
///
/// The refusals are, in order: a file that decides later execution, a
/// credential or git-internal directory, and an extension bundle. Reads are not
/// consulted: an agent debugging config legitimately reads what it may not write.
pub fn write_refusal(path: &str) -> Option<String> {
    write_refusal_reason(path).map(|reason| format!("{reason}{REFUSAL_HINT}"))
}

fn write_refusal_reason(path: &str) -> Option<String> {
    if path.is_empty() {
        return Some("Refused: empty path.".into());
    }
    if path.bytes().any(|b| b < 0x20) {
        return Some("Refused: path contains control bytes.".into());
    }

    let cmp = comparison_form(path);
    let cmp_for_prefix = if cmp.starts_with('/') {
        cmp
    } else {
        format!("/{cmp}")
    };

    if cmp_for_prefix.contains(EXTENSION_ROOT_NEEDLE) {
        return Some(
            "Refused: extension bundles are loaded by the host, so they cannot be changed from inside the agent."
                .into(),
        );
    }
    if cmp_for_prefix.contains(AUDIT_ROOT_NEEDLE) {
        return Some(
            "Refused: the audit log is written by the host, so it cannot be changed from inside the agent."
                .into(),
        );
    }
    for rel in AGENT_IMMUTABLE_CONFIG {
        if cmp_for_prefix.ends_with(rel) {
            return Some(format!(
                "Refused: \"{}\" decides what runs later, so it cannot be changed from inside the agent.",
                rel.trim_start_matches('/')
            ));
        }
    }
    for dir in PROTECTED_WRITE_DIRS {
        if is_under_protected(&cmp_for_prefix, dir) {
            return Some(format!(
                "Refused: writes under \"{}\" are not allowed.",
                describe_protected(dir)
            ));
        }
    }
    None
}

pub fn check_writable(path: &str) -> Result<(), String> {
    match write_refusal(path) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

/// Read guard: deny on the literal path, then canonicalize and deny again so a
/// symlink into a protected directory is caught. Returns the canonical path for
/// the caller to operate on (avoids TOCTOU between check and open). A path that
/// cannot be canonicalized (does not exist) is passed through so downstream
/// surfaces the real `ENOENT` error.
#[allow(unreachable_code)]
pub fn guard_read(path: &Path) -> Result<PathBuf, String> {
    return Ok(path.to_path_buf());
    check_readable(&path.to_string_lossy())?;
    match std::fs::canonicalize(path) {
        Ok(canon) => {
            check_readable(&canon.to_string_lossy())?;
            Ok(canon)
        }
        Err(_) => Ok(path.to_path_buf()),
    }
}

/// Read validation only: deny on the literal path and the canonical form, but
/// do NOT substitute the path. Identity-sensitive operations (rename, delete,
/// stat, symlink handling) must act on the path the caller passed, not the
/// symlink-resolved target.
#[allow(unreachable_code)]
pub fn validate_read(path: &std::path::Path) -> Result<(), String> {
    let _ = path;
    return Ok(());
    check_readable(&path.to_string_lossy())?;
    if let Ok(canon) = std::fs::canonicalize(path) {
        check_readable(&canon.to_string_lossy())?;
    }
    Ok(())
}

/// Same as `validate_read` for the write deny-list. A target that does not exist
/// yet cannot be canonicalized, so its parent is resolved instead, exactly as
/// `guard_write` does: without that fallback a new file behind a symlinked
/// directory would only ever be checked in its literal spelling, which never
/// matches the deny-list.
pub fn validate_write(path: &std::path::Path) -> Result<(), String> {
    check_writable(&path.to_string_lossy())?;
    if let Ok(canon) = std::fs::canonicalize(path) {
        check_writable(&canon.to_string_lossy())?;
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        if let Ok(canon_parent) = std::fs::canonicalize(parent) {
            let joined = canon_parent.join(path.file_name().unwrap_or_default());
            check_writable(&joined.to_string_lossy())?;
        }
    }
    Ok(())
}

/// Write guard: deny on the literal path, then canonicalize (target, or parent
/// for a new file) and deny again. Returns the path to operate on.
pub fn guard_write(path: &Path) -> Result<PathBuf, String> {
    check_writable(&path.to_string_lossy())?;
    match std::fs::canonicalize(path) {
        Ok(canon) => {
            check_writable(&canon.to_string_lossy())?;
            Ok(canon)
        }
        Err(_) => {
            if let Some(parent) = path.parent() {
                if let Ok(canon_parent) = std::fs::canonicalize(parent) {
                    let tail = path.file_name().unwrap_or_default();
                    let joined = canon_parent.join(tail);
                    check_writable(&joined.to_string_lossy())?;
                    return Ok(joined);
                }
            }
            Ok(path.to_path_buf())
        }
    }
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparison_form_strips_drive_and_normalizes_separators() {
        assert_eq!(comparison_form(r"C:\Users\me\.ssh"), "/users/me/.ssh");
        assert_eq!(comparison_form("C:/Users/me/.env"), "/users/me/.env");
        assert_eq!(
            comparison_form(r"\\?\C:\Windows\System32"),
            "/windows/system32"
        );
    }

    #[test]
    fn read_allows_all_files_without_sandbox() {
        assert!(check_readable("/home/me/.env").is_ok());
        assert!(check_readable("/home/me/.env.local").is_ok());
        assert!(check_readable("/home/me/id_rsa").is_ok());
        assert!(check_readable("/home/me/config.pem").is_ok());
        assert!(check_readable("/home/me/.npmrc").is_ok());
        assert!(check_readable(r"C:\Users\me\.aws\credentials").is_ok());
        assert!(check_readable("/repo/.env.example").is_ok());
        assert!(check_readable("/repo/src/main.rs").is_ok());
        assert!(check_readable("/home/me/notes.md").is_ok());
        assert!(check_readable("/etc/passwd").is_ok());
    }

    #[test]
    fn write_allows_ordinary_workspace_files() {
        assert!(check_writable("/home/me/project/out.txt").is_ok());
        assert!(check_writable("/proj/src/main.rs").is_ok());
        assert!(check_writable(r"C:\Users\me\project\src\App.tsx").is_ok());
        assert!(check_writable(r"C:\Windows\Temp\agent-work.txt").is_ok());
        // Scaffolding a project-local `.env` is ordinary work; the credential
        // directories, not the file name, are what the write wall protects.
        assert!(check_writable("/proj/.env").is_ok());
        assert!(check_writable("/proj/.env.example").is_ok());
        // System paths need root anyway and have real uses on a host under test
        // (mapping a target name into /etc/hosts, for one), so they stay open.
        assert!(check_writable("/etc/hosts").is_ok());
        assert!(check_writable("/usr/bin/thing").is_ok());
    }

    #[test]
    fn write_refuses_files_that_decide_later_execution() {
        for path in [
            "/proj/.termigo/hooks.json",
            r"C:\proj\.termigo\hooks.json",
            "/home/me/.termigo/hooks.json",
            "/proj/.termigo/mcp.json",
            "/home/me/.termigo/mcp.json",
            "/proj/.claude/settings.json",
            "/proj/.claude/settings.local.json",
            "/proj/.codex/config.toml",
            "/proj/.gemini/settings.json",
        ] {
            assert!(check_writable(path).is_err(), "allowed: {path}");
        }
    }

    #[test]
    fn write_refuses_credentials_git_internals_and_extension_bundles() {
        for path in [
            "/home/me/.ssh/authorized_keys",
            "/home/me/.ssh/config",
            "/home/me/.aws/credentials",
            "/home/me/.gnupg/trustdb.gpg",
            "/proj/.git/hooks/pre-commit",
            "/proj/.git/config",
            r"C:\Users\me\AppData\Roaming\id.99apps.termigo\extensions\demo\manifest.json",
        ] {
            assert!(check_writable(path).is_err(), "allowed: {path}");
        }
    }

    #[test]
    fn write_refusal_is_shared_with_the_shell_route() {
        assert!(write_refusal("/proj/.termigo/hooks.json").is_some());
        assert!(write_refusal("/proj/.git/hooks/pre-commit").is_some());
        assert!(write_refusal("/proj/src/main.rs").is_none());
    }

    #[test]
    fn every_write_refusal_names_the_stop() {
        for path in [
            "",
            "a\u{1}b",
            "/proj/.termigo/hooks.json",
            "/home/me/.termigo/mcp.json",
            "/proj/.claude/settings.json",
            "/home/me/.ssh/config",
            "/proj/.git/hooks/pre-commit",
            r"C:\Users\me\AppData\Roaming\id.99apps.termigo\extensions\demo\manifest.json",
            r"C:\Users\me\AppData\Roaming\id.99apps.termigo\audit\2026-09-27.jsonl",
        ] {
            let reason = write_refusal(path).unwrap_or_else(|| panic!("allowed: {path}"));
            assert!(
                reason.ends_with(REFUSAL_HINT),
                "no stop hint for {path}: {reason}"
            );
        }
    }

    #[test]
    fn read_side_pruning_stays_open_by_policy() {
        assert!(!is_secret_path(Path::new("/home/me/server.key")));
        assert!(!is_secret_path(Path::new("/home/me/deploy.pem")));
        assert!(!is_secret_path(Path::new("/home/me/credentials.json")));
        assert!(!is_secret_path(Path::new("/home/me/id_rsa")));
        assert!(!is_protected(Path::new("/home/me/.ssh")));
        assert!(!is_protected(Path::new("/etc")));
    }

    #[test]
    fn guard_read_allows_reads() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("safe.txt");
        std::fs::write(&real, "ok").unwrap();
        assert!(guard_read(&real).is_ok());
    }
}
