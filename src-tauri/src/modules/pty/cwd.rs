//! The working directory of a PTY's shell, read from the operating system
//! rather than from what the shell reports about itself.
//!
//! The frontend learns a pane's directory from OSC 7, which only arrives when
//! shell integration is active and the sequence survives to the terminal. Both
//! can fail without any error: a shell with no integration (fish without our
//! conf.d, dash, nu), a prompt framework that replaces our hook, and tmux, which
//! consumes OSC 7 and OSC 133 itself (`input_osc_7` stores the path on the tmux
//! pane and does not forward it) unless the sequence is DCS-wrapped. The pane
//! then keeps the directory it was opened in, and every consumer of that value
//! (tab, explorer root, the AI's workspace) follows it.
//!
//! This module answers "where is this shell now" from `/proc` (or from tmux,
//! when tmux sits between us and the shell). Unlike in-band OSC 7 it cannot be
//! forged by command output.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// Whether a `/proc/<pid>/comm` value names a tmux process. The client shows as
/// `tmux: client`, the server as `tmux: server`.
pub(crate) fn is_tmux_comm(comm: &str) -> bool {
    comm.trim().starts_with("tmux")
}

/// The path printed by `tmux display-message -p '#{pane_current_path}'`. Only
/// an absolute POSIX path is accepted (tmux runs on Unix, whatever host the
/// tests run on): an empty line or an error message is not a directory.
pub(crate) fn parse_tmux_path(output: &str) -> Option<PathBuf> {
    let line = output.lines().next()?.trim();
    line.starts_with('/').then(|| PathBuf::from(line))
}

fn same_directory(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// `/proc` reports the physical directory, while OSC 7 carries the shell's
/// logical `$PWD`. Through a symlink those are two spellings of one place, and
/// handing the physical one back would flip the pane between them at every
/// prompt. So when the caller's last known path names the same directory, keep
/// the caller's spelling.
pub(crate) fn prefer_hint(actual: PathBuf, hint: Option<&str>) -> String {
    if let Some(hint) = hint.map(str::trim).filter(|h| !h.is_empty()) {
        let hinted = Path::new(hint);
        if hinted.is_absolute() && same_directory(hinted, &actual) {
            return hint.to_string();
        }
    }
    actual.to_string_lossy().into_owned()
}

/// Resolve the shell's directory.
///
/// `leader` is the PTY's foreground process group leader and `tty` the PTY's
/// slave path. When the foreground process is a tmux client, the shell is a
/// child of the tmux server, so `/proc/<shell_pid>/cwd` would be the directory
/// the client started in; tmux is asked instead, for the pane shown to that
/// client (`-c <tty>`), which covers both our own persistence sessions and a
/// tmux the user started by hand.
#[cfg(target_os = "linux")]
pub(crate) fn resolve(
    leader: Option<i32>,
    tty: Option<&Path>,
    shell_pid: u64,
    hint: Option<&str>,
) -> Option<String> {
    if let (Some(leader), Some(tty)) = (leader.filter(|pid| *pid > 0), tty) {
        let comm = std::fs::read_to_string(format!("/proc/{leader}/comm")).unwrap_or_default();
        if is_tmux_comm(&comm) {
            if let Some(path) = tmux_pane_path(tty) {
                return Some(prefer_hint(path, hint));
            }
        }
    }
    let actual = std::fs::read_link(format!("/proc/{shell_pid}/cwd")).ok()?;
    Some(prefer_hint(actual, hint))
}

#[cfg(target_os = "linux")]
fn tmux_pane_path(tty: &Path) -> Option<PathBuf> {
    use std::process::{Command, Stdio};
    let output = Command::new("tmux")
        .args(["display-message", "-p", "-c"])
        .arg(tty)
        .arg("#{pane_current_path}")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_tmux_path(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_tmux_client_and_server() {
        assert!(is_tmux_comm("tmux: client\n"));
        assert!(is_tmux_comm("tmux: server"));
        assert!(is_tmux_comm("tmux"));
        assert!(!is_tmux_comm("bash\n"));
        assert!(!is_tmux_comm("sh"));
    }

    #[test]
    fn accepts_only_an_absolute_tmux_path() {
        assert_eq!(
            parse_tmux_path("/home/me/termixgo\n"),
            Some(PathBuf::from("/home/me/termixgo"))
        );
        assert_eq!(parse_tmux_path(""), None);
        assert_eq!(parse_tmux_path("\n"), None);
        assert_eq!(
            parse_tmux_path("no server running on /tmp/tmux-1000/default\n"),
            None
        );
    }

    #[test]
    fn keeps_the_callers_spelling_for_the_same_directory() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        // Same directory spelled with a redundant component.
        let spelled = format!("{}/./real", dir.path().display());
        assert_eq!(prefer_hint(real.clone(), Some(&spelled)), spelled);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_a_logical_symlink_path_instead_of_flipping_to_the_physical_one() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("data").join("project");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.path().join("work");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // /proc would report `real`; OSC 7 reported `link` (the shell's $PWD).
        let logical = link.to_string_lossy().into_owned();
        assert_eq!(prefer_hint(real, Some(&logical)), logical);
    }

    #[test]
    fn follows_the_shell_when_the_hint_is_a_different_directory() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("termixgo");
        let new = dir.path().join("home");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        let hint = old.to_string_lossy().into_owned();
        assert_eq!(
            prefer_hint(new.clone(), Some(&hint)),
            new.to_string_lossy().into_owned()
        );
        // No hint, an empty hint, a relative hint, or a missing directory all
        // fall back to what the OS reported.
        let expect = new.to_string_lossy().into_owned();
        assert_eq!(prefer_hint(new.clone(), None), expect);
        assert_eq!(prefer_hint(new.clone(), Some("  ")), expect);
        assert_eq!(prefer_hint(new.clone(), Some("relative/dir")), expect);
        assert_eq!(prefer_hint(new, Some("/definitely/not/a/dir")), expect);
    }
}
