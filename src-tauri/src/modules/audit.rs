//! Append-only audit log for agent activity.
//!
//! Written by the host rather than by a tool, because the point is a record the
//! agent cannot rewrite: the log directory sits in the write deny-list, so
//! `fs_write_file`, the shell route, and every tool an agent can reach are locked
//! out of it, while this command writes with `std::fs` directly.
//!
//! App-scoped rather than workspace-scoped on purpose. One file per day reads as a
//! single timeline across every project a session touched, which is what an
//! operator actually needs after an incident, and it needs no workspace plumbing
//! from the webview.
//!
//! Auditing is observation, so nothing here stops the work it observes: a full
//! disk or a malformed entry is logged and swallowed, and the caller always sees
//! `Ok`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// One line is one event. Bounded so a runaway caller cannot fill the disk with a
/// single entry, and refused rather than truncated: half a JSON object is worse
/// than a missing line when the log is the thing being read after an incident.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// Used when the caller's date is missing or malformed. Still a valid file name,
/// so the entry is never dropped over a naming problem.
const UNDATED: &str = "undated";

/// Append one event to `<app_data_dir>/audit/<date>.jsonl`.
///
/// The caller supplies the date because this crate has no calendar dependency;
/// it is validated here so a crafted value cannot steer the write out of the
/// audit directory. Appended with `O_APPEND` so concurrent runs interleave lines
/// instead of overwriting each other.
#[tauri::command]
pub fn audit_append(
    app: tauri::AppHandle,
    entry: serde_json::Value,
    date: Option<String>,
) -> Result<(), String> {
    let dir = match app.path().app_data_dir() {
        Ok(base) => base.join("audit"),
        Err(e) => {
            log::warn!("audit_append skipped: app_data_dir: {e}");
            return Ok(());
        }
    };
    let stem = date
        .filter(|d| is_plain_date(d))
        .unwrap_or_else(|| UNDATED.to_string());
    if let Err(e) = append_line(&dir, &stem, &entry) {
        log::warn!("audit_append skipped: {e}");
    }
    Ok(())
}

/// `YYYY-MM-DD` and nothing else: digits and dashes, fixed length. A value with a
/// separator, a parent segment, or a drive letter is not a date and must never
/// reach the path join.
fn is_plain_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| {
        if i == 4 || i == 7 {
            *b == b'-'
        } else {
            b.is_ascii_digit()
        }
    })
}

fn append_line(dir: &Path, stem: &str, entry: &serde_json::Value) -> Result<(), String> {
    let mut line = serde_json::to_string(entry).map_err(|e| format!("encode entry: {e}"))?;
    if line.len() > MAX_LINE_BYTES {
        return Err(format!(
            "entry is {} bytes, over the {MAX_LINE_BYTES} limit",
            line.len()
        ));
    }
    line.push('\n');

    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = audit_path(dir, stem);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("append {}: {e}", path.display()))?;
    Ok(())
}

fn audit_path(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn logs_in(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|entries| entries.filter_map(Result::ok).map(|e| e.path()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn writes_one_parseable_line_per_event() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("audit");

        append_line(
            &dir,
            "2026-09-27",
            &json!({"tool": "bash_run", "status": "ok"}),
        )
        .unwrap();
        append_line(
            &dir,
            "2026-09-27",
            &json!({"tool": "fs_write_file", "status": "refused"}),
        )
        .unwrap();

        let files = logs_in(&dir);
        assert_eq!(files.len(), 1, "one file per day");
        let body = std::fs::read_to_string(&files[0]).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "{body}");
        for line in lines {
            let parsed: serde_json::Value =
                serde_json::from_str(line).expect("each line parses on its own");
            assert!(parsed.get("tool").is_some());
        }
    }

    #[test]
    fn a_later_day_gets_its_own_file() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("audit");
        append_line(&dir, "2026-09-27", &json!({"tool": "a"})).unwrap();
        append_line(&dir, "2026-09-28", &json!({"tool": "b"})).unwrap();
        assert_eq!(logs_in(&dir).len(), 2);
    }

    #[test]
    fn an_oversized_entry_is_refused_instead_of_half_written() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("audit");
        let huge = json!({ "tool": "bash_run", "detail": "x".repeat(MAX_LINE_BYTES) });

        assert!(append_line(&dir, "2026-09-27", &huge).is_err());
        assert!(
            logs_in(&dir).is_empty(),
            "nothing may be created for a refusal"
        );
    }

    #[test]
    fn only_a_bare_date_is_accepted_as_a_file_name() {
        assert!(is_plain_date("2026-09-27"));
        for bad in [
            "",
            "2026-9-27",
            "2026-09-27.jsonl",
            "../../escape",
            "..\\..\\escape",
            "C:/Windows/Temp",
            "2026-09-27/../evil",
            "2026-09-27\n",
        ] {
            assert!(!is_plain_date(bad), "accepted: {bad}");
        }
    }

    #[test]
    fn an_invalid_date_falls_back_instead_of_escaping_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("audit");
        let entry = json!({"tool": "bash_run"});
        append_line(&dir, UNDATED, &entry).unwrap();
        let files = logs_in(&dir);
        assert_eq!(files.len(), 1);
        assert!(files[0].to_string_lossy().ends_with("undated.jsonl"));
    }
}
