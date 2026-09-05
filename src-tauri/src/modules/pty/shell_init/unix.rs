use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use super::{apply_common, tmux_available, wrap_in_tmux, ShellInfo, FISH_REINSTALL_PROMPT};
use crate::modules::control::ShellControlEnv;

const ZSHENV: &str = include_str!("../scripts/zshenv.zsh");
const ZPROFILE: &str = include_str!("../scripts/zprofile.zsh");
const ZLOGIN: &str = include_str!("../scripts/zlogin.zsh");
const ZSHRC: &str = include_str!("../scripts/zshrc.zsh");
const BASHRC: &str = include_str!("../scripts/bashrc.bash");
const FISH_INIT: &str = include_str!("../scripts/init.fish");

pub enum Shell {
    Zsh,
    Bash,
    Fish,
    Other,
}

impl Shell {
    pub fn classify(path: &str) -> Shell {
        match path.rsplit('/').next().unwrap_or("") {
            "zsh" => Shell::Zsh,
            "bash" => Shell::Bash,
            "fish" => Shell::Fish,
            _ => Shell::Other,
        }
    }

    pub fn detect() -> (Shell, String) {
        let path = login_shell()
            .or_else(|| std::env::var("SHELL").ok())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".into());
        (Self::classify(&path), path)
    }

    // A configured override wins only when it points at a real file;
    // otherwise fall back to the user's login shell.
    pub fn resolve(shell_override: Option<String>) -> (Shell, String) {
        if let Some(path) = shell_override
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            if Path::new(&path).is_file() {
                return (Self::classify(&path), path);
            }
            log::warn!("configured shell '{path}' not found, using auto-detect");
        }
        Self::detect()
    }
}

fn login_shell() -> Option<String> {
    use std::ffi::CStr;
    unsafe {
        let uid = libc::getuid();
        let pw = libc::getpwuid(uid);
        if pw.is_null() {
            return None;
        }
        let shell_ptr = (*pw).pw_shell;
        if shell_ptr.is_null() {
            return None;
        }
        CStr::from_ptr(shell_ptr).to_str().ok().map(String::from)
    }
}

pub fn list_shells() -> Vec<ShellInfo> {
    use std::collections::HashSet;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let (_, login) = Shell::detect();
    let mut candidates = vec![login];
    if let Ok(content) = fs::read_to_string("/etc/shells") {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            candidates.push(line.to_string());
        }
    }
    for path in candidates {
        if !seen.insert(path.clone()) || !Path::new(&path).is_file() {
            continue;
        }
        let integrated = !matches!(Shell::classify(&path), Shell::Other);
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        out.push(ShellInfo {
            name,
            path,
            integrated,
        });
    }
    out
}

pub fn build(
    cwd: Option<String>,
    blocks: bool,
    shell_override: Option<String>,
    control: Option<ShellControlEnv>,
    persist: bool,
    persist_key: Option<String>,
) -> Result<CommandBuilder, String> {
    let (shell, shell_path) = Shell::resolve(shell_override);
    let mut cmd = CommandBuilder::new(&shell_path);
    apply_common(&mut cmd, cwd, blocks, control.as_ref());
    apply_shell_init(&mut cmd, &shell, &shell_path);
    if persist {
        if let Some(key) = persist_key.filter(|k| !k.trim().is_empty()) {
            if tmux_available() {
                return Ok(wrap_in_tmux(&cmd, &key));
            }
            log::info!(
                "terminal persistence requested but tmux not found; using a normal shell"
            );
        }
    }
    Ok(cmd)
}

fn apply_shell_init(cmd: &mut CommandBuilder, shell: &Shell, shell_path: &str) {
    match shell {
        Shell::Zsh => {
            match prepare_zdotdir() {
                Ok(zdotdir) => {
                    // Guard against Termigo-in-Termigo :)
                    if let Ok(user_zd) = std::env::var("ZDOTDIR") {
                        if Path::new(&user_zd) != zdotdir.as_path() {
                            cmd.env("TERMIGO_USER_ZDOTDIR", user_zd);
                        }
                    }
                    cmd.env("ZDOTDIR", &zdotdir);
                }
                Err(e) => {
                    log::warn!("zsh shell integration disabled: {e}");
                }
            }
            // Login shell so /etc/zprofile runs path_helper on macOS — without
            // this, GUI-launched apps get a minimal PATH missing Homebrew.
            cmd.arg("-l");
        }
        Shell::Bash => {
            match prepare_bash_rcfile() {
                Ok(rc) => {
                    cmd.arg("--rcfile");
                    cmd.arg(rc);
                }
                Err(e) => {
                    log::warn!("bash shell integration disabled: {e}");
                }
            }
            // bash ignores --rcfile under -l, so we use -i and source
            // /etc/profile from inside our rcfile to emulate login init.
            cmd.arg("-i");
        }
        Shell::Fish => {
            if let Err(e) = prepare_fish_conf_d() {
                log::warn!("fish shell integration disabled: {e}");
            }
            // fish 4.0+ writes its own OSC 133 A/B; ours would double it.
            cmd.env("fish_features", "no-mark-prompt");
            cmd.arg("-i");
            // Re-assert our prompt after config.fish (-C runs last), so a
            // framework prompt (starship etc.) loaded there can't override
            // the markers and break cwd tracking.
            cmd.arg("-C");
            cmd.arg(FISH_REINSTALL_PROMPT);
        }
        Shell::Other => {
            log::info!(
                "unsupported shell '{}', spawning without integration",
                shell_path
            );
        }
    }
}

fn integration_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
    let root = home
        .join(".cache")
        .join("termigo")
        .join("shell-integration");
    fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    Ok(root)
}

fn prepare_zdotdir() -> Result<PathBuf, String> {
    let dir = integration_root()?.join("zsh");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    write_if_changed(&dir.join(".zshenv"), ZSHENV)?;
    write_if_changed(&dir.join(".zprofile"), ZPROFILE)?;
    write_if_changed(&dir.join(".zshrc"), ZSHRC)?;
    write_if_changed(&dir.join(".zlogin"), ZLOGIN)?;
    Ok(dir)
}

fn prepare_bash_rcfile() -> Result<PathBuf, String> {
    let dir = integration_root()?.join("bash");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let rc = dir.join("bashrc");
    write_if_changed(&rc, BASHRC)?;
    Ok(rc)
}

fn prepare_fish_conf_d() -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
    let dir = home.join(".config").join("fish").join("conf.d");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    write_if_changed(&dir.join("termigo.fish"), FISH_INIT)?;
    Ok(())
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    // Atomic replace: a parallel shell startup must never source a half-written file.
    let mut tmp: OsString = path.as_os_str().to_owned();
    tmp.push(".__termigo_tmp__");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_known_shells() {
        assert!(matches!(Shell::classify("/bin/zsh"), Shell::Zsh));
        assert!(matches!(Shell::classify("/usr/bin/bash"), Shell::Bash));
        assert!(matches!(
            Shell::classify("/opt/homebrew/bin/fish"),
            Shell::Fish
        ));
        assert!(matches!(Shell::classify("/bin/sh"), Shell::Other));
        assert!(matches!(Shell::classify("/usr/bin/nu"), Shell::Other));
    }

    #[test]
    fn resolve_uses_an_existing_override() {
        let exe = std::env::current_exe().unwrap();
        let path = exe.to_string_lossy().into_owned();
        let (_, resolved) = Shell::resolve(Some(path.clone()));
        assert_eq!(resolved, path);
    }

    #[test]
    fn resolve_falls_back_when_override_missing() {
        let (_, path) = Shell::resolve(Some("/no/such/shell/xyz".into()));
        assert!(!path.is_empty());
        assert_ne!(path, "/no/such/shell/xyz");
    }

    #[test]
    fn resolve_falls_back_on_empty_override() {
        let (_, fallback) = Shell::resolve(Some("   ".into()));
        let (_, detected) = Shell::detect();
        assert_eq!(fallback, detected);
    }

    #[test]
    fn builds_unix_fish_launch_with_post_config_rewrap() {
        let mut cmd = CommandBuilder::new("/usr/bin/fish");
        apply_shell_init(&mut cmd, &Shell::Fish, "/usr/bin/fish");
        let argv: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            argv,
            vec![
                "/usr/bin/fish".to_string(),
                "-i".to_string(),
                "-C".to_string(),
                FISH_REINSTALL_PROMPT.to_string(),
            ]
        );
    }
}
