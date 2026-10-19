//! GUI-launched apps get a bare PATH on macOS, and servers like
//! typescript-language-server need the user's PATH themselves to find
//! `node`. Capture the login shell env once, reuse for detect and spawn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

#[cfg(unix)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Empty on Windows (full user env is inherited there) or if capture failed.
pub fn server_env_overlay() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        #[cfg(unix)]
        {
            match capture_login_env() {
                Some(env) => env,
                None => {
                    log::warn!("lsp: login shell env capture failed, using process env");
                    HashMap::new()
                }
            }
        }
        #[cfg(windows)]
        {
            HashMap::new()
        }
    })
}

pub fn resolve_binary(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let path = server_env_overlay()
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok());
    which::which_in(command, path, cwd).ok()
}

#[cfg(unix)]
fn capture_login_env() -> Option<HashMap<String, String>> {
    use shared_child::SharedChild;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::sync::Arc;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = Command::new(&shell);
    // `env` is resolved by the login shell's own PATH rather than hardcoded
    // `/usr/bin/env`: on BusyBox/Alpine, Nix and other minimal systems it lives
    // in `/bin`, and the absolute path produced no output at all. A non-GNU
    // `env` may not support `-0` either, so the parser below accepts both
    // NUL-separated and newline-separated output.
    cmd.args(["-l", "-c", "env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let child = Arc::new(SharedChild::spawn(&mut cmd).ok()?);
    let mut stdout = child.take_stdout()?;
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("termigo-lsp-env-capture".into())
        .spawn(move || {
            let mut buf = Vec::with_capacity(8 * 1024);
            let _ = stdout.read_to_end(&mut buf);
            let _ = tx.send(buf);
        })
        .ok()?;

    let bytes = match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(b) => {
            let _ = child.wait();
            b
        }
        Err(_) => {
            log::warn!("lsp: login shell env capture timed out after {CAPTURE_TIMEOUT:?}");
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };

    let env = parse_env_bytes(&bytes);
    if env.is_empty() {
        return None;
    }
    Some(env)
}

/// Parse `env` output into a map. GNU `env -0` separates entries with NUL; when
/// the shell's `env` does not support `-0` (BusyBox) the output is
/// newline-separated, so fall back to that rather than returning nothing.
/// Values keep a trailing CR on CRLF systems, which is stripped.
/// A continuation line without `=` is folded into the previous value instead
/// of becoming a bogus entry, so a multi-line value degrades to one entry
/// rather than corrupting the map.
#[cfg(unix)]
fn parse_env_bytes(bytes: &[u8]) -> HashMap<String, String> {
    if bytes.contains(&0) {
        return bytes
            .split(|&b| b == 0)
            .filter(|chunk| !chunk.is_empty())
            .filter_map(|chunk| {
                let s = std::str::from_utf8(chunk).ok()?;
                let (k, v) = s.split_once('=')?;
                if k.is_empty() {
                    return None;
                }
                Some((k.to_string(), v.trim_end_matches('\r').to_string()))
            })
            .collect();
    }
    let mut env: HashMap<String, String> = HashMap::new();
    let mut last_key: Option<String> = None;
    for chunk in bytes.split(|&b| b == b'\n') {
        if chunk.is_empty() {
            continue;
        }
        let s = match std::str::from_utf8(chunk) {
            Ok(s) => s,
            Err(_) => continue,
        };
        match s.split_once('=') {
            Some((k, v)) if !k.is_empty() => {
                last_key = Some(k.to_string());
                env.insert(
                    k.to_string(),
                    v.trim_end_matches('\r').to_string(),
                );
            }
            _ => {
                // No `=`: a wrapped line of a multi-line value. Keep it with
                // the previous entry instead of dropping or misparsing it.
                if let Some(key) = last_key.clone() {
                    if let Some(prev) = env.get_mut(&key) {
                        prev.push('\n');
                        prev.push_str(s.trim_end_matches('\r'));
                    }
                }
            }
        }
    }
    env
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn resolve_binary_finds_sh() {
        let p = resolve_binary("sh").expect("sh must resolve");
        assert!(p.is_absolute());
    }

    #[test]
    fn resolve_binary_rejects_empty_and_missing() {
        assert!(resolve_binary("").is_none());
        assert!(resolve_binary("   ").is_none());
        assert!(resolve_binary("termigo-definitely-not-a-real-binary").is_none());
    }

    #[test]
    fn parse_env_bytes_prefers_nul_separator() {
        let bytes = b"PATH=/usr/bin:/bin\0HOME=/root\0";
        let env = parse_env_bytes(bytes);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin:/bin"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/root"));
    }

    #[test]
    fn parse_env_bytes_falls_back_to_newlines_and_folds_continuations() {
        let bytes = b"PATH=/usr/bin:/bin\nMULTI=one\ntwo\nHOME=/root\n";
        let env = parse_env_bytes(bytes);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin:/bin"));
        assert_eq!(env.get("MULTI").map(String::as_str), Some("one\ntwo"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/root"));
    }
}
