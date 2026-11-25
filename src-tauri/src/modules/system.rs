//! System helpers the agent can call: clipboard read/write and environment
//! variable inspection.
//!
//! Clipboard uses `arboard` (already in the dependency tree transitively, so
//! no new download). Environment access is read-only on purpose: the agent
//! may inspect the process environment to answer questions (PATH, HOME,
//! TERM, ...), but mutating the parent process's environment would be both
//! useless (child shells snapshot their own) and surprising.

use serde::Serialize;

/// Read the current clipboard text.
#[tauri::command]
pub fn clipboard_get() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.get_text().map_err(|e| e.to_string())
}

/// Replace the clipboard text.
#[tauri::command]
pub fn clipboard_set(text: String) -> Result<(), String> {
    // Cap so a runaway agent cannot stuff gigabytes into the clipboard.
    if text.len() > 4 * 1024 * 1024 {
        return Err("clipboard text too large (max 4 MB)".into());
    }
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct EnvVar {
    name: String,
    value: String,
}

/// Read one environment variable by name.
#[tauri::command]
pub fn env_get(name: String) -> Result<Option<String>, String> {
    if name.is_empty() || name.len() > 256 || name.bytes().any(|b| b == 0) {
        return Err("invalid variable name".into());
    }
    Ok(std::env::var(&name).ok())
}

/// List environment variables, newest-sensitive names first (those most likely
/// to be read by shells/tools). Values are capped per-var and only a bounded
/// number of variables are returned so a huge environment cannot flood the
/// model's context.
#[tauri::command]
pub fn env_list() -> Vec<EnvVar> {
    const MAX_VARS: usize = 200;
    const MAX_VALUE: usize = 4000;
    let mut vars: Vec<EnvVar> = std::env::vars()
        .map(|(name, value)| EnvVar {
            name: name.clone(),
            value: if value.chars().count() > MAX_VALUE {
                let cut: String = value.chars().take(MAX_VALUE).collect();
                format!("{cut}…")
            } else {
                value
            },
        })
        .collect();
    // Stable ordering: PATH-like vars and common ones first, then the rest
    // alphabetically. Deterministic output beats whatever hash order `vars()`
    // happens to use.
    vars.sort_by(|a, b| {
        let pa = priority(&a.name);
        let pb = priority(&b.name);
        pb.cmp(&pa).then_with(|| a.name.cmp(&b.name))
    });
    vars.truncate(MAX_VARS);
    vars
}

#[derive(Serialize)]
pub struct SystemSnapshot {
    pub os: String,
    pub arch: String,
    pub hostname: Option<String>,
    pub cpu_count: usize,
    pub load_average: Option<[f64; 3]>,
    pub memory_total_bytes: Option<u64>,
    pub memory_available_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_free_bytes: Option<u64>,
}

#[derive(Serialize)]
pub struct DiskUsage {
    pub path: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub used_percent: u8,
}

#[derive(Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub command: String,
}

#[derive(Serialize)]
pub struct ListeningPort {
    pub protocol: String,
    pub address: String,
    pub port: u16,
}

#[tauri::command]
pub fn system_snapshot() -> SystemSnapshot {
    let (memory_total_bytes, memory_available_bytes, swap_total_bytes, swap_free_bytes) =
        linux_memory();
    SystemSnapshot {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname(),
        cpu_count: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        load_average: load_average(),
        memory_total_bytes,
        memory_available_bytes,
        swap_total_bytes,
        swap_free_bytes,
    }
}

#[tauri::command]
pub fn system_disk_usage(
    path: String,
    registry: tauri::State<'_, crate::modules::workspace::WorkspaceRegistry>,
) -> Result<DiskUsage, String> {
    if path.is_empty() || path.len() > 4096 || path.bytes().any(|b| b == 0) {
        return Err("invalid disk path".to_string());
    }
    // A disk-usage probe names an arbitrary filesystem location, so it goes
    // through the same workspace authorization as every other path-taking
    // command (enforced by tests/command_authorization.rs).
    crate::modules::workspace::require_authorized(&registry, std::path::Path::new(&path))?;
    let output = std::process::Command::new("df")
        .args(["-P", "-k", "--", &path])
        .output()
        .map_err(|e| format!("run df: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .nth(1)
        .ok_or_else(|| "df returned no filesystem row".to_string())?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 5 {
        return Err("unexpected df output".to_string());
    }
    let total_kb = fields[1].parse::<u64>().map_err(|_| "invalid total size")?;
    let used_kb = fields[2].parse::<u64>().map_err(|_| "invalid used size")?;
    let available_kb = fields[3]
        .parse::<u64>()
        .map_err(|_| "invalid available size")?;
    let used_percent = fields[4]
        .trim_end_matches('%')
        .parse::<u8>()
        .map_err(|_| "invalid used percentage")?;
    Ok(DiskUsage {
        path,
        total_bytes: total_kb.saturating_mul(1024),
        used_bytes: used_kb.saturating_mul(1024),
        available_bytes: available_kb.saturating_mul(1024),
        used_percent,
    })
}

#[tauri::command]
pub fn system_processes(limit: Option<u32>) -> Result<Vec<ProcessInfo>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    #[cfg(target_os = "linux")]
    {
        let mut processes = Vec::new();
        for entry in std::fs::read_dir("/proc").map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(pid) = name.parse::<u32>() else {
                continue;
            };
            let stat = std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
            let parent_pid = stat
                .rsplit_once(") ")
                .and_then(|(_, rest)| rest.split_whitespace().nth(1))
                .and_then(|v| v.parse().ok());
            let command = std::fs::read_to_string(entry.path().join("comm"))
                .unwrap_or_default()
                .trim()
                .to_string();
            processes.push(ProcessInfo {
                pid,
                parent_pid,
                command,
            });
            if processes.len() >= limit {
                break;
            }
        }
        processes.sort_by_key(|p| p.pid);
        Ok(processes)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = limit;
        Err("system_processes is currently supported on Linux only".to_string())
    }
}

#[tauri::command]
pub fn system_listening_ports() -> Result<Vec<ListeningPort>, String> {
    #[cfg(target_os = "linux")]
    {
        let mut ports = Vec::new();
        for (protocol, file) in [("tcp", "/proc/net/tcp"), ("tcp6", "/proc/net/tcp6")] {
            let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
            for line in text.lines().skip(1) {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.get(3) != Some(&"0A") {
                    continue;
                }
                let Some(local) = fields.get(1) else { continue };
                let Some((address, port)) = local.split_once(':') else {
                    continue;
                };
                let Ok(port) = u16::from_str_radix(port, 16) else {
                    continue;
                };
                ports.push(ListeningPort {
                    protocol: protocol.to_string(),
                    address: address.to_string(),
                    port,
                });
            }
        }
        ports.sort_by_key(|p| (p.port, p.protocol.clone()));
        Ok(ports)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("system_listening_ports is currently supported on Linux only".to_string())
    }
}

fn hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn load_average() -> Option<[f64; 3]> {
    let text = std::fs::read_to_string("/proc/loadavg").ok()?;
    let mut values = text.split_whitespace().take(3).map(|v| v.parse().ok());
    Some([values.next()??, values.next()??, values.next()??])
}

fn linux_memory() -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
        return (None, None, None, None);
    };
    let value = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key))
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.saturating_mul(1024))
    };
    (
        value("MemTotal:"),
        value("MemAvailable:"),
        value("SwapTotal:"),
        value("SwapFree:"),
    )
}

/// Priority for env-list ordering: shells and tools read these first.
fn priority(name: &str) -> u8 {
    let upper = name.to_ascii_uppercase();
    if matches!(upper.as_str(), "PATH" | "PATHEXT") {
        return 3;
    }
    if matches!(
        upper.as_str(),
        "HOME" | "USER" | "USERNAME" | "SHELL" | "TERM" | "LANG" | "PWD" | "CWD"
    ) {
        return 2;
    }
    if upper == "HISTFILE" {
        return 1;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_gets_top_priority() {
        assert_eq!(priority("PATH"), 3);
        assert_eq!(priority("pathext"), 3);
    }

    #[test]
    fn common_shell_vars_get_middle_priority() {
        assert_eq!(priority("HOME"), 2);
        assert_eq!(priority("TERM"), 2);
        assert_eq!(priority("cwd"), 2);
    }

    #[test]
    fn histfile_gets_low_priority_and_everything_else_zero() {
        assert_eq!(priority("HISTFILE"), 1);
        assert_eq!(priority("NODE_ENV"), 0);
        assert_eq!(priority("RANDOM_THING_123"), 0);
    }
}
