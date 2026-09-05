use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use super::{apply_common, ensure_utf8_locale, ShellInfo, FISH_REINSTALL_PROMPT};
use crate::modules::control::ShellControlEnv;
use crate::modules::workspace::WorkspaceEnv;

const PROFILE_PS1: &str = include_str!("../scripts/profile.ps1");
const BASHRC_SCRIPT: &str = include_str!("../scripts/bashrc.bash");
const ZSHENV_SCRIPT: &str = include_str!("../scripts/zshenv.zsh");
const ZPROFILE_SCRIPT: &str = include_str!("../scripts/zprofile.zsh");
const ZLOGIN_SCRIPT: &str = include_str!("../scripts/zlogin.zsh");
const ZSHRC_SCRIPT: &str = include_str!("../scripts/zshrc.zsh");
const FISH_INIT_SCRIPT: &str = include_str!("../scripts/init.fish");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShellKind {
    Zsh,
    Bash,
    Fish,
    Other,
}

impl ShellKind {
    fn from_path(path: &str) -> Self {
        match path.rsplit('/').next().unwrap_or("") {
            "zsh" => Self::Zsh,
            "bash" => Self::Bash,
            "fish" => Self::Fish,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum WslShellIntegration {
    Zsh {
        zdotdir: String,
        user_zdotdir: Option<String>,
    },
    Bash {
        rcfile: String,
    },
    Fish,
    None,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WslLaunchSpec {
    args: Vec<String>,
}

pub fn build(
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    blocks: bool,
    shell: Option<String>,
    control: Option<ShellControlEnv>,
    _persist: bool,
    _persist_key: Option<String>,
) -> Result<CommandBuilder, String> {
    if let WorkspaceEnv::Wsl { distro } = workspace {
        let _ = (blocks, shell, control);
        return build_wsl(cwd, distro);
    }
    let shell_path = shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(windows_shell_path);
    let shell_name = shell_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let is_powershell = shell_name == "pwsh.exe" || shell_name == "powershell.exe";
    let is_bash = shell_name == "bash.exe";

    let mut cmd = CommandBuilder::new(&shell_path);
    apply_common(&mut cmd, cwd, blocks, control.as_ref());

    if is_powershell {
        match prepare_ps_profile() {
            Ok(profile) => {
                cmd.arg("-NoLogo");
                cmd.arg("-NoExit");
                cmd.arg("-ExecutionPolicy");
                cmd.arg("Bypass");
                cmd.arg("-File");
                cmd.arg(profile);
            }
            Err(e) => {
                log::warn!("powershell shell integration disabled: {e}");
            }
        }
    } else if is_bash {
        // git-bash's /etc/profile cd's to $HOME unless CHERE_INVOKING is
        // set; keep the cwd we configured in apply_common.
        cmd.env("CHERE_INVOKING", "1");
        // Native git-bash: same OSC 7/133 rcfile as Unix bash, in the
        // forward-slash form MSYS bash accepts.
        match prepare_bash_rcfile() {
            Ok(rc) => {
                cmd.arg("--rcfile");
                cmd.arg(rc.to_string_lossy().replace('\\', "/"));
                cmd.arg("-i");
            }
            Err(e) => {
                log::warn!("bash shell integration disabled: {e}");
            }
        }
    } else {
        log::info!("spawning {} without shell integration", shell_name);
    }

    log::info!("spawning Windows shell: {}", shell_path.display());
    Ok(cmd)
}

fn build_wsl(cwd: Option<String>, distro: String) -> Result<CommandBuilder, String> {
    crate::modules::workspace::validate_wsl_distro_name(&distro)?;
    let shell_path = crate::modules::workspace::wsl_login_shell(distro.clone())?;
    let shell_kind = ShellKind::from_path(&shell_path);
    let integration = match shell_kind {
        ShellKind::Zsh => match prepare_wsl_zdotdir(&distro) {
            Ok(zdotdir) => {
                let user_zdotdir = match probe_wsl_zdotdir(&distro, &shell_path) {
                    Ok(path) if !path.is_empty() && path != zdotdir => Some(path),
                    Ok(_) => None,
                    Err(e) => {
                        log::warn!("WSL zsh ZDOTDIR probe failed for {distro}: {e}");
                        None
                    }
                };
                WslShellIntegration::Zsh {
                    zdotdir,
                    user_zdotdir,
                }
            }
            Err(e) => {
                log::warn!("WSL zsh shell integration disabled for {distro}: {e}");
                WslShellIntegration::None
            }
        },
        ShellKind::Bash => match prepare_wsl_bash_rcfile(&distro) {
            Ok(rcfile) => WslShellIntegration::Bash { rcfile },
            Err(e) => {
                log::warn!("WSL bash shell integration disabled for {distro}: {e}");
                WslShellIntegration::None
            }
        },
        ShellKind::Fish => match prepare_wsl_fish_conf_d(&distro) {
            Ok(()) => WslShellIntegration::Fish,
            Err(e) => {
                log::warn!("WSL fish shell integration disabled for {distro}: {e}");
                WslShellIntegration::None
            }
        },
        ShellKind::Other => {
            log::info!(
                "unsupported WSL shell '{}', spawning without integration",
                shell_path
            );
            WslShellIntegration::None
        }
    };
    let spec = build_wsl_launch_spec(
        cwd.as_deref(),
        &distro,
        &shell_path,
        shell_kind,
        integration,
    );
    let mut cmd = CommandBuilder::new("wsl.exe");
    for arg in &spec.args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERMIGO_TERMINAL", "1");
    ensure_utf8_locale(&mut cmd);
    log::info!("spawning WSL shell: {distro} ({shell_path})");
    Ok(cmd)
}

fn build_wsl_launch_spec(
    cwd: Option<&str>,
    distro: &str,
    shell_path: &str,
    shell_kind: ShellKind,
    integration: WslShellIntegration,
) -> WslLaunchSpec {
    let mut args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--cd".to_string(),
        cwd.filter(|s| !s.is_empty()).unwrap_or("~").to_string(),
        "--exec".to_string(),
    ];
    match (shell_kind, integration) {
        (
            ShellKind::Zsh,
            WslShellIntegration::Zsh {
                zdotdir,
                user_zdotdir,
            },
        ) => {
            args.push("env".to_string());
            if let Some(user_zdotdir) = user_zdotdir {
                args.push(format!("TERMIGO_USER_ZDOTDIR={user_zdotdir}"));
            }
            args.push(format!("ZDOTDIR={zdotdir}"));
            args.push(shell_path.to_string());
            args.push("-l".to_string());
        }
        (ShellKind::Bash, WslShellIntegration::Bash { rcfile }) => {
            args.push(shell_path.to_string());
            args.push("--rcfile".to_string());
            args.push(rcfile);
            args.push("-i".to_string());
        }
        (ShellKind::Fish, WslShellIntegration::Fish) => {
            args.push("env".to_string());
            args.push("fish_features=no-mark-prompt".to_string());
            args.push(shell_path.to_string());
            args.push("-i".to_string());
            args.push("-C".to_string());
            args.push(FISH_REINSTALL_PROMPT.to_string());
        }
        (ShellKind::Zsh, WslShellIntegration::None) => {
            args.push(shell_path.to_string());
            args.push("-l".to_string());
        }
        (ShellKind::Bash, WslShellIntegration::None)
        | (ShellKind::Fish, WslShellIntegration::None) => {
            args.push(shell_path.to_string());
            args.push("-i".to_string());
        }
        (ShellKind::Other, _) => args.push(shell_path.to_string()),
        _ => {
            args.push(shell_path.to_string());
        }
    }
    WslLaunchSpec { args }
}

fn probe_wsl_zdotdir(distro: &str, shell_path: &str) -> Result<String, String> {
    let out = crate::modules::workspace::wsl_exec_capture(
        distro,
        shell_path,
        &["-c", r#"printf %s "${ZDOTDIR:-$HOME}""#],
    )?;
    Ok(crate::modules::workspace::normalize_wsl_value(out, ""))
}

fn prepare_wsl_integration_dir(distro: &str, shell: &str) -> Result<(String, PathBuf), String> {
    let home = crate::modules::workspace::wsl_home_blocking(distro)?;
    let linux_dir = format!(
        "{}/.cache/termigo/shell-integration/{shell}",
        home.trim_end_matches('/')
    );
    let unc_dir = crate::modules::workspace::wsl_path_to_unc(distro, &linux_dir);
    fs::create_dir_all(&unc_dir).map_err(|e| format!("create {}: {e}", unc_dir.display()))?;
    Ok((linux_dir, unc_dir))
}

fn normalize_script(content: &str) -> String {
    content.replace("\r\n", "\n")
}

fn prepare_wsl_zdotdir(distro: &str) -> Result<String, String> {
    let (linux_dir, unc_dir) = prepare_wsl_integration_dir(distro, "zsh")?;
    write_if_changed(&unc_dir.join(".zshenv"), &normalize_script(ZSHENV_SCRIPT))?;
    write_if_changed(
        &unc_dir.join(".zprofile"),
        &normalize_script(ZPROFILE_SCRIPT),
    )?;
    write_if_changed(&unc_dir.join(".zshrc"), &normalize_script(ZSHRC_SCRIPT))?;
    write_if_changed(&unc_dir.join(".zlogin"), &normalize_script(ZLOGIN_SCRIPT))?;
    Ok(linux_dir)
}

fn prepare_wsl_bash_rcfile(distro: &str) -> Result<String, String> {
    let (linux_dir, _unc_dir) = prepare_wsl_integration_dir(distro, "bash")?;
    let linux_rc = format!("{linux_dir}/bashrc");
    let unc_file = crate::modules::workspace::wsl_path_to_unc(distro, &linux_rc);
    let content = normalize_script(BASHRC_SCRIPT);
    write_if_changed(&unc_file, &content)?;
    Ok(linux_rc)
}

fn prepare_wsl_fish_conf_d(distro: &str) -> Result<(), String> {
    let home = crate::modules::workspace::wsl_home_blocking(distro)?;
    let linux_dir = format!("{}/.config/fish/conf.d", home.trim_end_matches('/'));
    let unc_dir = crate::modules::workspace::wsl_path_to_unc(distro, &linux_dir);
    fs::create_dir_all(&unc_dir).map_err(|e| format!("create {}: {e}", unc_dir.display()))?;
    let unc_file = unc_dir.join("termigo.fish");
    let content = normalize_script(FISH_INIT_SCRIPT);
    write_if_changed(&unc_file, &content)?;
    Ok(())
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

fn prepare_ps_profile() -> Result<PathBuf, String> {
    let dir = integration_root()?.join("powershell");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let file = dir.join("profile.ps1");
    write_if_changed(&file, PROFILE_PS1)?;
    Ok(file)
}

fn prepare_bash_rcfile() -> Result<PathBuf, String> {
    let dir = integration_root()?.join("bash");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let rc = dir.join("bashrc");
    write_if_changed(&rc, &normalize_script(BASHRC_SCRIPT))?;
    Ok(rc)
}

pub fn list_shells() -> Vec<ShellInfo> {
    fn add(out: &mut Vec<ShellInfo>, name: &str, path: PathBuf, integrated: bool) {
        if path.is_file() {
            out.push(ShellInfo {
                name: name.to_string(),
                path: path.to_string_lossy().into_owned(),
                integrated,
            });
        }
    }

    let mut out = Vec::new();
    if let Some(p) = which_in_path("pwsh.exe") {
        add(&mut out, "PowerShell", p, true);
    } else if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        add(
            &mut out,
            "PowerShell",
            pf.join("PowerShell").join("7").join("pwsh.exe"),
            true,
        );
    }
    let system32 = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32");
    add(
        &mut out,
        "Windows PowerShell",
        system32
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        true,
    );
    add(&mut out, "Command Prompt", system32.join("cmd.exe"), false);
    if let Some(p) = git_bash_path() {
        add(&mut out, "Git Bash", p, true);
    }
    out
}

fn git_bash_path() -> Option<PathBuf> {
    // Git for Windows install locations only. A bash.exe on PATH is usually
    // the WSL launcher in System32, which is the separate WSL switcher.
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
        if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
            for rel in [
                r"Git\bin\bash.exe",
                r"Git\usr\bin\bash.exe",
                r"Programs\Git\bin\bash.exe",
            ] {
                let candidate = base.join(rel);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

pub fn windows_shell_path() -> PathBuf {
    if let Some(p) = which_in_path("pwsh.exe") {
        return p;
    }

    if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        let candidate = pf.join("PowerShell").join("7").join("pwsh.exe");
        if candidate.is_file() {
            return candidate;
        }
    }

    let system32 = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32");
    let ps5 = system32
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if ps5.is_file() {
        return ps5;
    }

    system32.join("cmd.exe")
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
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
    fn builds_wsl_zsh_launch_spec_with_env_and_login() {
        let spec = build_wsl_launch_spec(
            Some("/home/vinicios/repo"),
            "Ubuntu",
            "/usr/bin/zsh",
            ShellKind::Zsh,
            WslShellIntegration::Zsh {
                zdotdir: "/home/vinicios/.cache/termigo/shell-integration/zsh".into(),
                user_zdotdir: None,
            },
        );
        assert_eq!(
            spec.args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--cd".to_string(),
                "/home/vinicios/repo".to_string(),
                "--exec".to_string(),
                "env".to_string(),
                "ZDOTDIR=/home/vinicios/.cache/termigo/shell-integration/zsh".to_string(),
                "/usr/bin/zsh".to_string(),
                "-l".to_string(),
            ]
        );
    }

    #[test]
    fn builds_wsl_zsh_launch_spec_with_user_zdotdir_probe() {
        let spec = build_wsl_launch_spec(
            Some("/home/vinicios/repo"),
            "Ubuntu",
            "/usr/bin/zsh",
            ShellKind::Zsh,
            WslShellIntegration::Zsh {
                zdotdir: "/home/vinicios/.cache/termigo/shell-integration/zsh".into(),
                user_zdotdir: Some("/home/vinicios/.config/zsh".into()),
            },
        );
        assert_eq!(
            spec.args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--cd".to_string(),
                "/home/vinicios/repo".to_string(),
                "--exec".to_string(),
                "env".to_string(),
                "TERMIGO_USER_ZDOTDIR=/home/vinicios/.config/zsh".to_string(),
                "ZDOTDIR=/home/vinicios/.cache/termigo/shell-integration/zsh".to_string(),
                "/usr/bin/zsh".to_string(),
                "-l".to_string(),
            ]
        );
    }

    #[test]
    fn builds_wsl_zsh_launch_spec_without_integration_still_uses_login_shell() {
        let spec = build_wsl_launch_spec(
            Some("/home/vinicios/repo"),
            "Ubuntu",
            "/usr/bin/zsh",
            ShellKind::Zsh,
            WslShellIntegration::None,
        );
        assert_eq!(
            spec.args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--cd".to_string(),
                "/home/vinicios/repo".to_string(),
                "--exec".to_string(),
                "/usr/bin/zsh".to_string(),
                "-l".to_string(),
            ]
        );
    }

    #[test]
    fn builds_wsl_bash_launch_spec_with_rcfile() {
        let spec = build_wsl_launch_spec(
            Some("/home/vinicios/repo"),
            "Ubuntu",
            "/bin/bash",
            ShellKind::Bash,
            WslShellIntegration::Bash {
                rcfile: "/home/vinicios/.cache/termigo/shell-integration/bash/bashrc".into(),
            },
        );
        assert_eq!(
            spec.args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--cd".to_string(),
                "/home/vinicios/repo".to_string(),
                "--exec".to_string(),
                "/bin/bash".to_string(),
                "--rcfile".to_string(),
                "/home/vinicios/.cache/termigo/shell-integration/bash/bashrc".to_string(),
                "-i".to_string(),
            ]
        );
    }

    #[test]
    fn builds_wsl_fish_launch_spec_without_init_command() {
        let spec = build_wsl_launch_spec(
            Some("/home/vinicios/repo"),
            "Ubuntu",
            "/usr/bin/fish",
            ShellKind::Fish,
            WslShellIntegration::Fish,
        );
        assert_eq!(
            spec.args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--cd".to_string(),
                "/home/vinicios/repo".to_string(),
                "--exec".to_string(),
                "env".to_string(),
                "fish_features=no-mark-prompt".to_string(),
                "/usr/bin/fish".to_string(),
                "-i".to_string(),
                "-C".to_string(),
                FISH_REINSTALL_PROMPT.to_string(),
            ]
        );
    }

    #[test]
    fn builds_wsl_other_shell_without_integration() {
        let spec = build_wsl_launch_spec(
            None,
            "Ubuntu",
            "/usr/bin/nu",
            ShellKind::Other,
            WslShellIntegration::None,
        );
        assert_eq!(
            spec.args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--cd".to_string(),
                "~".to_string(),
                "--exec".to_string(),
                "/usr/bin/nu".to_string(),
            ]
        );
    }
}
