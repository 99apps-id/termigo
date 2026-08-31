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
