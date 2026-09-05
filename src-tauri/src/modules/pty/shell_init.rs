use std::ffi::OsString;
use std::path::PathBuf;

use portable_pty::CommandBuilder;

use crate::modules::control::ShellControlEnv;
use crate::modules::workspace::{self, WorkspaceEnv};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::windows_shell_path;

// Terminal-process persistence. When the user opts in and tmux is present, the
// leaf's shell is hosted inside a named tmux session so it survives an app
// restart; on the next open `-A` reattaches to the still-running session.
// These helpers are unix-only in practice but kept compiled on all platforms
// so clippy checks them; the Windows build simply never calls them.
#[allow(dead_code)]
const PERSIST_SESSION_PREFIX: &str = "termigo-";

#[allow(dead_code)]
fn tmux_session_name(persist_key: &str) -> String {
    let filtered: String = persist_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(48)
        .collect();
    format!("{PERSIST_SESSION_PREFIX}{filtered}")
}

#[allow(dead_code)]
fn tmux_available() -> bool {
    #[cfg(unix)]
    {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                if dir.join("tmux").is_file() {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(not(unix))]
    {
        // tmux persistence targets unix shells; inert elsewhere.
        false
    }
}

/// Whether terminal-process persistence is usable on this host. Windows has no
/// tmux (and a ConPTY child is bound to a Job Object that kills it on app
/// exit), so this is false there; on Unix it is true only when tmux is on PATH.
/// The frontend uses this to keep the "persist terminals" setting from being a
/// silent no-op.
#[allow(dead_code)]
pub(crate) fn persist_available() -> bool {
    tmux_available()
}

// Clone the built shell command and prepend a tmux create-or-attach wrapper.
// Cloning keeps every env var (TERMIGO_TERMINAL, shell-integration hooks, cwd)
// intact on the tmux client, and tmux passes them through to the session.
#[allow(dead_code)]
fn wrap_in_tmux(cmd: &CommandBuilder, persist_key: &str) -> CommandBuilder {
    let mut wrapped = cmd.clone();
    let mut argv: Vec<OsString> = vec![
        OsString::from("tmux"),
        OsString::from("new-session"),
        OsString::from("-A"),
        OsString::from("-s"),
        OsString::from(tmux_session_name(persist_key)),
        OsString::from("--"),
    ];
    argv.extend(cmd.get_argv().iter().cloned());
    *wrapped.get_argv_mut() = argv;
    wrapped
}

const FISH_REINSTALL_PROMPT: &str =
    "functions -q __termigo_install_prompt; and __termigo_install_prompt";

pub fn build_command(
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    blocks: bool,
    shell: Option<String>,
    control: Option<ShellControlEnv>,
    persist: bool,
    persist_key: Option<String>,
) -> Result<CommandBuilder, String> {
    let shell = sanitize_shell_override(shell);
    #[cfg(unix)]
    {
        let _ = workspace;
        unix::build(cwd, blocks, shell, control, persist, persist_key)
    }
    #[cfg(windows)]
    {
        windows::build(cwd, workspace, blocks, shell, control, persist, persist_key)
    }
}

// Honor the override only if it matches an enumerated shell, so a tampered
// setting can't spawn an arbitrary binary across the IPC boundary.
fn sanitize_shell_override(shell: Option<String>) -> Option<String> {
    let candidate = shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let target = std::fs::canonicalize(&candidate).ok();
    let allowed = list_shells().into_iter().any(|s| {
        s.path == candidate || (target.is_some() && std::fs::canonicalize(&s.path).ok() == target)
    });
    if allowed {
        Some(candidate)
    } else {
        log::warn!("ignoring non-enumerated shell override '{candidate}'");
        None
    }
}

pub fn detect_shell_name() -> String {
    #[cfg(unix)]
    {
        let (_, path) = unix::Shell::detect();
        path.rsplit('/').next().unwrap_or("").to_string()
    }
    #[cfg(windows)]
    {
        windows_shell_path()
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default()
    }
}

#[derive(serde::Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    /// True when Termigo injects OSC 7/133 integration for this shell (cwd
    /// tracking, command blocks, agent detection). Others spawn bare.
    pub integrated: bool,
}

pub fn list_shells() -> Vec<ShellInfo> {
    #[cfg(unix)]
    {
        unix::list_shells()
    }
    #[cfg(windows)]
    {
        windows::list_shells()
    }
}

fn ensure_utf8_locale(cmd: &mut CommandBuilder) {
    let is_utf8 = |v: &str| {
        let up = v.to_ascii_uppercase();
        up.contains("UTF-8") || up.contains("UTF8")
    };
    let already_utf8 = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| std::env::var(k).ok().as_deref().is_some_and(is_utf8));
    if already_utf8 {
        return;
    }
    #[cfg(target_os = "macos")]
    let fallback = "en_US.UTF-8";
    #[cfg(all(unix, not(target_os = "macos")))]
    let fallback = "C.UTF-8";
    #[cfg(windows)]
    let fallback = "en_US.UTF-8";
    cmd.env("LANG", fallback);
}

fn apply_common(
    cmd: &mut CommandBuilder,
    cwd: Option<String>,
    blocks: bool,
    control: Option<&ShellControlEnv>,
) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERMIGO_TERMINAL", "1");
    if blocks {
        cmd.env("TERMIGO_BLOCKS", "1");
    }
    let appimage_overrides = workspace::appimage_env_overrides();
    let clean_path = match appimage_overrides.iter().find(|(key, _)| *key == "PATH") {
        Some((_, value)) => value.clone(),
        None => std::env::var_os("PATH"),
    };
    for (key, value) in appimage_overrides {
        match value {
            Some(v) => {
                cmd.env(key, v);
            }
            None => {
                cmd.env_remove(key);
            }
        }
    }
    if let Some(control) = control {
        cmd.env("TERMIGO_CONTROL_ADDR", &control.address);
        cmd.env("TERMIGO_CONTROL_TOKEN", &control.token);
        cmd.env("TERMIGO_PANE_ID", control.pane_id.to_string());
        if let Some(path) = &control.cli_path {
            cmd.env("TERMIGO_CLI", path);
        }
        if let Some(bin_dir) = &control.cli_bin_dir {
            let paths = std::iter::once(bin_dir.clone()).chain(
                clean_path
                    .as_deref()
                    .into_iter()
                    .flat_map(std::env::split_paths),
            );
            if let Ok(path) = std::env::join_paths(paths) {
                cmd.env("PATH", path);
            }
        }
    }
    ensure_utf8_locale(cmd);

    let resolved_cwd = cwd
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| workspace::launch_cwd_snapshot().filter(|p| p.is_dir()))
        .or_else(|| dirs::home_dir().filter(|p| p.is_dir()));
    if let Some(cwd) = resolved_cwd {
        #[cfg(windows)]
        let cwd = PathBuf::from(cwd.to_string_lossy().replace('/', "\\"));
        log::info!("pty cwd: {}", cwd.display());
        cmd.cwd(cwd);
    } else {
        log::warn!("pty cwd: no usable directory, inheriting from process");
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use portable_pty::CommandBuilder;

    use super::{apply_common, sanitize_shell_override, ShellControlEnv};

    #[test]
    fn rejects_non_enumerated_override() {
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(sanitize_shell_override(Some(exe)), None);
    }

    #[test]
    fn empty_or_missing_override_is_none() {
        assert_eq!(sanitize_shell_override(Some("   ".into())), None);
        assert_eq!(sanitize_shell_override(None), None);
    }

    #[test]
    fn common_env_includes_authenticated_caller_context() {
        let mut command = CommandBuilder::new("shell");
        let control = ShellControlEnv {
            address: "127.0.0.1:1234".into(),
            token: "secret".into(),
            pane_id: 42,
            cli_path: Some("/app/termigo-cli".into()),
            cli_bin_dir: Some(std::path::PathBuf::from("/app/bin")),
        };
        apply_common(&mut command, None, false, Some(&control));

        assert_eq!(
            command.get_env("TERMIGO_CONTROL_ADDR"),
            Some(OsStr::new("127.0.0.1:1234"))
        );
        assert_eq!(
            command.get_env("TERMIGO_CONTROL_TOKEN"),
            Some(OsStr::new("secret"))
        );
        assert_eq!(command.get_env("TERMIGO_PANE_ID"), Some(OsStr::new("42")));
        assert_eq!(
            command.get_env("TERMIGO_CLI"),
            Some(OsStr::new("/app/termigo-cli"))
        );
        assert_eq!(
            command
                .get_env("PATH")
                .and_then(|path| std::env::split_paths(path).next()),
            Some(std::path::PathBuf::from("/app/bin"))
        );
    }
}
