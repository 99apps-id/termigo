use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use termigo_control_protocol::ControlDescriptor;

use super::validation::constant_time_eq;

pub const STALE_LAUNCHER_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("generate control token: {error}"))?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}

pub fn descriptor_path() -> Result<PathBuf, String> {
    let cache =
        dirs::cache_dir().ok_or_else(|| "could not resolve user cache directory".to_string())?;
    let dir = cache.join("termigo");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("create control directory {}: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure control directory {}: {error}", dir.display()))?;
    }
    Ok(dir.join("control.json"))
}

pub fn write_descriptor(path: &Path, descriptor: &ControlDescriptor) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "control descriptor path has no parent".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("create control descriptor: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("secure control descriptor: {error}"))?;
    }
    serde_json::to_writer(&mut temp, descriptor)
        .map_err(|error| format!("serialize control descriptor: {error}"))?;
    temp.write_all(b"\n")
        .map_err(|error| format!("write control descriptor: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("sync control descriptor: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("publish control descriptor: {}", error.error))?;
    Ok(())
}

pub fn remove_own_descriptor(path: &Path, token: &str) {
    let owned = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ControlDescriptor>(&bytes).ok())
        .is_some_and(|descriptor| constant_time_eq(descriptor.token.as_bytes(), token.as_bytes()));
    if owned {
        let _ = std::fs::remove_file(path);
    }
}

pub fn find_bundled_cli() -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        "termigo-cli.exe"
    } else {
        "termigo-cli"
    };
    if let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.join(filename)))
        .filter(|path| is_cli_candidate(path))
    {
        return Some(path);
    }

    if cfg!(debug_assertions) {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let target = option_env!("TAURI_ENV_TARGET_TRIPLE")?;
        let candidate = binaries.join(format!(
            "termigo-cli-{target}{}",
            std::env::consts::EXE_SUFFIX
        ));
        return is_cli_candidate(&candidate).then_some(candidate);
    }
    None
}

pub fn is_cli_candidate(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

pub fn sweep_stale_launcher_dirs(descriptor: &Path) {
    let Some(control_dir) = descriptor.parent() else {
        return;
    };
    let run_root = control_dir.join("run");
    let Ok(entries) = std::fs::read_dir(&run_root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        if launcher_dir_is_stale(&name, modified, now, process_is_alive) {
            if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                log::warn!(
                    "could not remove stale CLI launcher {}: {error}",
                    entry.path().display()
                );
            }
        }
    }
}

pub fn launcher_dir_is_stale(
    name: &str,
    modified: Option<SystemTime>,
    now: SystemTime,
    is_alive: impl Fn(u32) -> bool,
) -> bool {
    match name.parse::<u32>() {
        Ok(pid) => !is_alive(pid),
        Err(_) => modified
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_LAUNCHER_MAX_AGE),
    }
}

#[cfg(unix)]
pub fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !handle.is_null() {
            CloseHandle(handle);
            true
        } else {
            GetLastError() == ERROR_ACCESS_DENIED
        }
    }
}

pub fn prepare_cli_launcher(descriptor: &Path, cli_path: &Path) -> Result<PathBuf, String> {
    let control_dir = descriptor
        .parent()
        .ok_or_else(|| "control descriptor path has no parent".to_string())?;
    let run_dir = control_dir.join("run").join(std::process::id().to_string());
    let bin_dir = run_dir.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("create CLI launcher directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure CLI run directory: {error}"))?;
        std::fs::set_permissions(&bin_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure CLI bin directory: {error}"))?;
    }

    let launcher = bin_dir.join(if cfg!(windows) {
        "termigo.exe"
    } else {
        "termigo"
    });
    if std::fs::symlink_metadata(&launcher).is_ok() {
        std::fs::remove_file(&launcher)
            .map_err(|error| format!("replace stale CLI launcher: {error}"))?;
    }
    if std::fs::hard_link(cli_path, &launcher).is_err() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(cli_path, &launcher)
            .map_err(|error| format!("link CLI launcher: {error}"))?;
        #[cfg(windows)]
        {
            std::fs::copy(cli_path, &launcher)
                .map_err(|error| format!("copy CLI launcher: {error}"))?;
        }
    }
    Ok(bin_dir)
}

pub fn remove_launcher_dir(bin_dir: &Path) {
    let launcher = bin_dir.join(if cfg!(windows) {
        "termigo.exe"
    } else {
        "termigo"
    });
    let _ = std::fs::remove_file(launcher);
    let _ = std::fs::remove_dir(bin_dir);
    if let Some(run_dir) = bin_dir.parent() {
        let _ = std::fs::remove_dir(run_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termigo_control_protocol::PROTOCOL_VERSION;

    #[test]
    fn launcher_cleanup_preserves_live_pids_and_expires_other_stale_entries() {
        let now = SystemTime::UNIX_EPOCH + STALE_LAUNCHER_MAX_AGE * 2;
        assert!(!launcher_dir_is_stale(
            "42",
            Some(SystemTime::UNIX_EPOCH),
            now,
            |pid| pid == 42
        ));
        assert!(launcher_dir_is_stale("43", Some(now), now, |_| false));
        assert!(launcher_dir_is_stale(
            "invalid",
            Some(SystemTime::UNIX_EPOCH),
            now,
            |_| true
        ));
        assert!(!launcher_dir_is_stale("invalid", Some(now), now, |_| true));
    }

    #[test]
    fn stale_pid_launcher_directories_are_removed() {
        let temp = tempfile::tempdir().expect("temp directory");
        let descriptor = temp.path().join("control.json");
        let stale = temp.path().join("run").join(u32::MAX.to_string());
        std::fs::create_dir_all(stale.join("bin")).expect("create stale launcher");

        sweep_stale_launcher_dirs(&descriptor);

        assert!(!stale.exists());
    }

    #[test]
    fn launcher_exposes_the_public_command() {
        let temp = tempfile::tempdir().expect("temp directory");
        let cli = temp.path().join(if cfg!(windows) {
            "termigo-cli.exe"
        } else {
            "termigo-cli"
        });
        std::fs::write(&cli, b"cli").expect("write fake CLI");
        let descriptor = temp.path().join("control.json");

        let bin_dir = prepare_cli_launcher(&descriptor, &cli).expect("prepare launcher");
        let launcher = bin_dir.join(if cfg!(windows) {
            "termigo.exe"
        } else {
            "termigo"
        });
        assert_eq!(std::fs::read(&launcher).expect("read launcher"), b"cli");

        remove_launcher_dir(&bin_dir);
        assert!(!launcher.exists());
    }

    #[test]
    fn descriptor_cleanup_preserves_a_newer_instance() {
        let temp = tempfile::tempdir().expect("temp directory");
        let path = temp.path().join("control.json");
        let descriptor = ControlDescriptor {
            protocol: PROTOCOL_VERSION,
            address: "127.0.0.1:4312".into(),
            token: "b".repeat(64),
            pid: 22,
            app_version: "test".into(),
        };
        write_descriptor(&path, &descriptor).expect("write descriptor");

        remove_own_descriptor(&path, &"a".repeat(64));
        assert!(path.exists());

        remove_own_descriptor(&path, &descriptor.token);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_is_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp directory");
        let path = temp.path().join("control.json");
        let descriptor = ControlDescriptor {
            protocol: PROTOCOL_VERSION,
            address: "127.0.0.1:4312".into(),
            token: "a".repeat(64),
            pid: 11,
            app_version: "test".into(),
        };
        write_descriptor(&path, &descriptor).expect("write descriptor");

        let mode = std::fs::metadata(path)
            .expect("descriptor metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
