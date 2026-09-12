//! Path-safety guards for the raw `fs::*` IPC commands.
//!
//! The AI tools carry their own deny-list on the frontend
//! (`src/modules/ai/lib/security.ts`), but the commands registered in
//! `lib.rs` are callable directly from the webview and therefore bypass it.
//! A compromised webview (or an extension running in the main webview) must
//! not be able to read `~/.ssh/id_rsa` or write `/etc/passwd` just because the
//! AI layer was never in the path. This module is the Rust mirror of that
//! deny-list, applied to every read, write, and mutation command.
//!
//! It is a defense layer, not a sandbox: the user-confirmation UI and the
//! workspace registry remain the real controls. These checks stop the obvious
//! secret paths in both the literal form and the canonical (symlink-resolved)
//! form, so a symlink planted at an innocent path is caught on the second pass.

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
const PROTECTED_DIRS: &[&str] = &[
    "/.ssh",
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
];

/// Write-only deny prefixes. Read access is not universally blocked, writing to
/// system locations always is.
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
    "/windows/",
    "/program files/",
    "/program files (x86)/",
    "/programdata/",
];

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
        // `//?/C:/x` -> `C:/x`, so the drive-strip below then yields `/x`.
        s = rest.to_string();
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
                let trimmed = seg[..colon].trim_end_matches(|c: char| c == '.' || c.is_whitespace());
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

fn is_under_protected(cmp: &str, dir: &str) -> bool {
    format!("{cmp}/").contains(&format!("{dir}/"))
}

/// Whether a path sits under a protected directory, for walker pruning. Uses
/// the raw string only: the walkers already never follow symlinks, and a
/// per-entry canonicalize over a 50k-entry tree would be far too slow. A
/// symlinked-in secret is instead caught by the canonical pass in
/// `validate_read` / `guard_read` on the explicit read/write path.
pub fn is_protected(path: &Path) -> bool {
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
pub fn is_secret_path(path: &Path) -> bool {
    let name = match path.file_name() {
        Some(n) => n.to_string_lossy(),
        None => return false,
    };
    if name.is_empty() || safe_env_template().is_match(&name) {
        return false;
    }
    secret_basename_patterns().iter().any(|re| re.is_match(&name))
}

fn describe_protected(dir: &str) -> &str {
    dir.trim_start_matches('/')
}

pub fn check_readable(path: &str) -> Result<(), String> {
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

pub fn check_writable(path: &str) -> Result<(), String> {
    check_readable(path)?;

    let cmp = comparison_form(path);
    let cmp_for_prefix = if cmp.starts_with('/') {
        cmp
    } else {
        format!("/{cmp}")
    };
    for prefix in WRITE_DENY_PREFIXES {
        if cmp_for_prefix.starts_with(prefix) || format!("{cmp_for_prefix}/").starts_with(prefix) {
            return Err(format!(
                "Refused: writes under \"{}\" are not allowed.",
                prefix.trim_end_matches('/')
            ));
        }
    }
    Ok(())
}

/// Read guard: deny on the literal path, then canonicalize and deny again so a
/// symlink into a protected directory is caught. Returns the canonical path for
/// the caller to operate on (avoids TOCTOU between check and open). A path that
/// cannot be canonicalized (does not exist) is passed through so downstream
/// surfaces the real `ENOENT` error.
pub fn guard_read(path: &Path) -> Result<PathBuf, String> {
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
pub fn validate_read(path: &std::path::Path) -> Result<(), String> {
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
    fn comparison_form_strips_ads_and_trailing_dot_space() {
        assert_eq!(comparison_form("C:/a/.env::$DATA"), "/a/.env");
        assert_eq!(comparison_form("C:/a/.env."), "/a/.env");
        assert_eq!(comparison_form("C:/a/.env "), "/a/.env");
    }

    #[test]
    fn read_blocks_secret_basenames() {
        assert!(check_readable("/home/me/.env").is_err());
        assert!(check_readable("/home/me/.env.local").is_err());
        assert!(check_readable("/home/me/id_rsa").is_err());
        assert!(check_readable("/home/me/config.pem").is_err());
        assert!(check_readable("/home/me/.npmrc").is_err());
        assert!(check_readable(r"C:\Users\me\.aws\credentials").is_err());
    }

    #[test]
    fn read_allows_env_template_and_plain_files() {
        assert!(check_readable("/repo/.env.example").is_ok());
        assert!(check_readable("/repo/.env.template").is_ok());
        assert!(check_readable("/repo/src/main.rs").is_ok());
        assert!(check_readable("/home/me/notes.md").is_ok());
    }

    #[test]
    fn read_blocks_protected_directories_and_descendants() {
        assert!(check_readable("/home/me/.ssh").is_err());
        assert!(check_readable("/home/me/.ssh/config").is_err());
        assert!(check_readable("/home/me/.git/config").is_err());
        assert!(check_readable("/etc/passwd").is_err());
        assert!(check_readable("/proc/self/environ").is_err());
        // Not a raw-substring false positive: `.sshx` is fine.
        assert!(check_readable("/home/me/.sshx/notes").is_ok());
    }

    #[test]
    fn write_blocks_system_prefixes_but_not_plain_reads() {
        assert!(check_writable("/etc/hosts").is_err());
        assert!(check_writable("/usr/bin/thing").is_err());
        assert!(check_writable(r"C:\Windows\System32\x").is_err());
        assert!(check_writable("/home/me/project/out.txt").is_ok());
        // Reading a system path is not universally blocked; writing is.
        assert!(check_readable("/usr/bin/ls").is_ok());
    }

    // A destination that does not exist yet cannot be canonicalized, so the
    // deny-list has to look at the resolved parent. Otherwise a `..`-free but
    // symlinked directory would only ever be checked in its literal spelling,
    // which never matches a protected prefix.
    #[cfg(unix)]
    #[test]
    fn validate_write_resolves_the_parent_of_a_new_file() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        // /usr/bin is write-denied and is a real directory on both Linux and
        // macOS (unlike /etc, which is a symlink on macOS and would resolve to
        // /private/etc, a path the deny-list does not cover).
        let link = dir.path().join("usr-bin-link");
        symlink("/usr/bin", &link).unwrap();
        let escaped = link.join("termigo-should-not-write");

        assert!(check_writable(&escaped.to_string_lossy()).is_ok());
        assert!(validate_write(&escaped).is_err());

        // A new file in an ordinary directory is still allowed.
        assert!(validate_write(&dir.path().join("new.txt")).is_ok());
    }

    #[test]
    fn control_bytes_are_rejected() {
        assert!(check_readable("/tmp/.env\x00.tail").is_err());
        assert!(check_readable("/tmp/.env\ntail").is_err());
    }

    #[test]
    fn is_secret_path_flags_non_hidden_secret_names() {
        // None of these are dotfiles, so the walker's hidden filter never drops
        // them and the basename deny-list is the only thing between a content
        // search and the secret.
        assert!(is_secret_path(Path::new("/home/me/server.key")));
        assert!(is_secret_path(Path::new("/home/me/deploy.pem")));
        assert!(is_secret_path(Path::new("/home/me/credentials.json")));
        assert!(is_secret_path(Path::new("/home/me/id_rsa")));
        assert!(is_secret_path(Path::new("/home/me/known_hosts")));
        assert!(is_secret_path(Path::new("/home/me/service-account.json")));
        // Committed templates stay readable, and ordinary files stay visible.
        assert!(!is_secret_path(Path::new("/repo/.env.example")));
        assert!(!is_secret_path(Path::new("/repo/src/main.rs")));
        assert!(!is_secret_path(Path::new("/home/me/project")));
    }

    #[test]
    fn guard_read_rejects_symlink_into_protected_dir() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("safe.txt");
        std::fs::write(&real, "ok").unwrap();
        assert!(guard_read(&real).is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let ssh = dir.path().join(".ssh");
            std::fs::create_dir(&ssh).unwrap();
            std::fs::write(ssh.join("id_rsa"), "secret").unwrap();
            let link = dir.path().join("link");
            if symlink(&ssh, &link).is_ok() {
                assert!(guard_read(&link.join("id_rsa")).is_err());
            }
        }
    }
}
