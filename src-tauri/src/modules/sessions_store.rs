use serde::{
    de::{self, Deserializer as _, MapAccess, Visitor},
    ser::SerializeMap,
    Deserialize, Serialize,
};
use std::{
    fmt,
    fs::{self, File},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tempfile::NamedTempFile;

const LEGACY_STORE_FILENAME: &str = "termigo-ai-sessions.json";
const LEGACY_BACKUP_FILENAME: &str = "termigo-ai-sessions.json.bak";
const LEGACY_IN_PROGRESS_BACKUP_FILENAME: &str = "termigo-ai-sessions.json.migrating.bak";
const LEGACY_MESSAGES_PREFIX: &str = "messages:";

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub migrated: usize,
    pub already_migrated: usize,
    pub backup_created: bool,
}

#[derive(Serialize)]
struct SessionDoc<'a> {
    messages: &'a serde_json::Value,
}

/// Per-session filename in `app_data_dir`. Matches JS `sessionStorePath(id)`
/// byte-for-byte: unescaped characters are `A-Z a-z 0-9 - _ ~`; all other
/// UTF-8 bytes are percent-encoded as uppercase `%XX`.
pub fn session_store_path(id: &str) -> String {
    let mut safe = String::with_capacity(id.len());
    for byte in id.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'~' => {
                safe.push(*byte as char);
            }
            b => {
                use std::fmt::Write as _;
                let _ = write!(safe, "%{b:02X}");
            }
        }
    }
    format!("termigo-ai-session-{safe}.json")
}

fn atomic_write_json_serializable<T: Serialize>(target: &Path, value: &T) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("target path has no parent: {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;

    let mut tmp = NamedTempFile::new_in(parent)
        .map_err(|e| format!("create temp file in {}: {e}", parent.display()))?;
    {
        let mut writer = BufWriter::new(tmp.as_file_mut());
        serde_json::to_writer(&mut writer, value)
            .map_err(|e| format!("serialize json for {}: {e}", target.display()))?;
        writer
            .flush()
            .map_err(|e| format!("flush temp file for {}: {e}", target.display()))?;
    }
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("sync_all temp file for {}: {e}", target.display()))?;
    tmp.persist(target)
        .map_err(|e| format!("persist {}: {}", target.display(), e.error))?;
    Ok(())
}

fn verify_existing_session_file(path: &Path) -> Result<bool, String> {
    let file = File::open(path).map_err(|e| format!("open existing {}: {e}", path.display()))?;
    let reader = BufReader::new(file);
    let parsed: serde_json::Value = match serde_json::from_reader(reader) {
        Ok(v) => v,
        Err(_) => return Ok(false),
    };
    Ok(parsed
        .as_object()
        .and_then(|obj| obj.get("messages"))
        .is_some_and(|v| v.is_array()))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn unique_backup_path(dir: &Path, bak_path: &Path) -> PathBuf {
    if !bak_path.exists() {
        return bak_path.to_path_buf();
    }
    let ts = now_millis();
    let candidate = dir.join(format!("{LEGACY_BACKUP_FILENAME}.{ts}"));
    if !candidate.exists() {
        return candidate;
    }
    let mut seq = 1u64;
    loop {
        let next = dir.join(format!("{LEGACY_BACKUP_FILENAME}.{ts}.{seq}"));
        if !next.exists() {
            return next;
        }
        seq += 1;
    }
}

fn recover_from_backup_if_missing(
    dir: &Path,
    sessions_path: &Path,
    bak_path: &Path,
    in_progress_bak_path: &Path,
) -> Result<(), String> {
    if in_progress_bak_path.exists() {
        if !sessions_path.exists() {
            // Crash happened after moving sessions_path -> in_progress_bak_path and
            // before persisting the compacted store. Restore the deterministic
            // in-progress backup rather than any stale prior .bak file.
            fs::rename(in_progress_bak_path, sessions_path).map_err(|e| {
                format!(
                    "recover {} from {}: {e}",
                    sessions_path.display(),
                    in_progress_bak_path.display()
                )
            })?;
        } else {
            // Crash happened after persisting compacted sessions_path and before
            // archiving the in-progress backup. Finalize it now.
            let backup_dest = unique_backup_path(dir, bak_path);
            fs::rename(in_progress_bak_path, &backup_dest).map_err(|e| {
                format!(
                    "finalize backup {} -> {}: {e}",
                    in_progress_bak_path.display(),
                    backup_dest.display()
                )
            })?;
        }
    } else if !sessions_path.exists() && bak_path.exists() {
        fs::rename(bak_path, sessions_path).map_err(|e| {
            format!(
                "recover {} from {}: {e}",
                sessions_path.display(),
                bak_path.display()
            )
        })?;
    }
    Ok(())
}

struct LegacyStreamVisitor<'a, S: serde::Serializer> {
    dir: &'a Path,
    serializer: S,
    migrated: usize,
    already_migrated: usize,
}

impl<'de, 'a, S> Visitor<'de> for LegacyStreamVisitor<'a, S>
where
    S: serde::Serializer<Ok = (), Error = serde_json::Error>,
{
    type Value = (usize, usize);

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON object representing the legacy sessions store")
    }

    fn visit_map<A>(mut self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut out_map = self
            .serializer
            .serialize_map(None)
            .map_err(de::Error::custom)?;

        while let Some(key) = map.next_key::<String>()? {
            if let Some(id) = key.strip_prefix(LEGACY_MESSAGES_PREFIX) {
                if !id.is_empty() {
                    let val: serde_json::Value = map.next_value()?;
                    let target = self.dir.join(session_store_path(id));
                    if target.exists() {
                        let valid =
                            verify_existing_session_file(&target).map_err(de::Error::custom)?;
                        if !valid {
                            return Err(de::Error::custom(format!(
                                "existing per-session store {} is invalid or missing messages; aborting migration to preserve legacy data",
                                target.display()
                            )));
                        }
                        self.already_migrated += 1;
                    } else {
                        atomic_write_json_serializable(&target, &SessionDoc { messages: &val })
                            .map_err(de::Error::custom)?;
                        self.migrated += 1;
                    }
                    continue;
                }
            }

            let val: serde_json::Value = map.next_value()?;
            out_map
                .serialize_entry(&key, &val)
                .map_err(de::Error::custom)?;
        }

        out_map.end().map_err(de::Error::custom)?;
        Ok((self.migrated, self.already_migrated))
    }
}

/// Stream-migrate all `messages:<id>` keys (including orphan keys not present
/// in `sessions`) from `termigo-ai-sessions.json` into per-session files with
/// bounded memory (one session value in memory at a time).
///
/// Guarantees:
/// - Writes each per-session file atomically (temp file + `sync_all` + `persist`).
/// - Never overwrites an existing valid per-session file.
/// - Preserves a `.bak` backup of the legacy file before replacing it.
/// - If any error occurs or a target file is corrupt, aborts without modifying
///   or deleting `termigo-ai-sessions.json`.
pub fn migrate_legacy_sessions_in_dir(dir: &Path) -> Result<MigrationReport, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let sessions_path = dir.join(LEGACY_STORE_FILENAME);
    let bak_path = dir.join(LEGACY_BACKUP_FILENAME);
    let in_progress_bak_path = dir.join(LEGACY_IN_PROGRESS_BACKUP_FILENAME);

    recover_from_backup_if_missing(dir, &sessions_path, &bak_path, &in_progress_bak_path)?;

    if !sessions_path.exists() {
        return Ok(MigrationReport {
            migrated: 0,
            already_migrated: 0,
            backup_created: false,
        });
    }

    let file =
        File::open(&sessions_path).map_err(|e| format!("open {}: {e}", sessions_path.display()))?;
    let reader = BufReader::with_capacity(256 * 1024, file);
    let mut deserializer = serde_json::Deserializer::from_reader(reader);

    let mut migrating_tmp = NamedTempFile::new_in(dir)
        .map_err(|e| format!("create migration temp file in {}: {e}", dir.display()))?;

    let (migrated, already_migrated) = {
        let writer = BufWriter::with_capacity(64 * 1024, migrating_tmp.as_file_mut());
        let mut serializer = serde_json::Serializer::new(writer);
        let visitor = LegacyStreamVisitor {
            dir,
            serializer: &mut serializer,
            migrated: 0,
            already_migrated: 0,
        };
        let counts = deserializer
            .deserialize_map(visitor)
            .map_err(|e| format!("stream-parse {}: {e}", sessions_path.display()))?;
        deserializer
            .end()
            .map_err(|e| format!("trailing data in {}: {e}", sessions_path.display()))?;
        let mut writer = serializer.into_inner();
        writer
            .flush()
            .map_err(|e| format!("flush compacted sessions temp file: {e}"))?;
        counts
    };

    if migrated == 0 && already_migrated == 0 {
        // Nothing to compact; leave termigo-ai-sessions.json untouched.
        return Ok(MigrationReport {
            migrated: 0,
            already_migrated: 0,
            backup_created: false,
        });
    }

    migrating_tmp
        .as_file()
        .sync_all()
        .map_err(|e| format!("sync_all compacted sessions temp file: {e}"))?;

    fs::rename(&sessions_path, &in_progress_bak_path).map_err(|e| {
        format!(
            "backup {} -> {}: {e}",
            sessions_path.display(),
            in_progress_bak_path.display()
        )
    })?;

    if let Err(e) = migrating_tmp.persist(&sessions_path) {
        let _ = fs::rename(&in_progress_bak_path, &sessions_path);
        return Err(format!(
            "persist compacted {}: {}",
            sessions_path.display(),
            e.error
        ));
    }

    let backup_dest = unique_backup_path(dir, &bak_path);
    fs::rename(&in_progress_bak_path, &backup_dest).map_err(|e| {
        format!(
            "finalize backup {} -> {}: {e}",
            in_progress_bak_path.display(),
            backup_dest.display()
        )
    })?;

    Ok(MigrationReport {
        migrated,
        already_migrated,
        backup_created: true,
    })
}

pub fn save_session_messages_in_dir(
    dir: &Path,
    id: &str,
    messages: &serde_json::Value,
) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = dir.join(session_store_path(id));
    atomic_write_json_serializable(&target, &SessionDoc { messages })
}

pub fn load_session_messages_in_dir(
    dir: &Path,
    id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = dir.join(session_store_path(id));
    if !target.exists() {
        return Ok(None);
    }
    let file = File::open(&target).map_err(|e| format!("open {}: {e}", target.display()))?;
    let reader = BufReader::new(file);
    let mut parsed: serde_json::Value =
        serde_json::from_reader(reader).map_err(|e| format!("parse {}: {e}", target.display()))?;
    Ok(parsed
        .as_object_mut()
        .and_then(|obj| obj.remove("messages")))
}

pub fn delete_session_messages_in_dir(dir: &Path, id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = dir.join(session_store_path(id));
    if target.exists() {
        fs::remove_file(&target).map_err(|e| format!("remove {}: {e}", target.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sessions_migrate_legacy(app: tauri::AppHandle) -> Result<MigrationReport, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || migrate_legacy_sessions_in_dir(&dir))
        .await
        .map_err(|e| format!("sessions_migrate_legacy task failed: {e}"))?
}

#[tauri::command]
pub async fn sessions_save_messages(
    app: tauri::AppHandle,
    id: String,
    messages: serde_json::Value,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || save_session_messages_in_dir(&dir, &id, &messages))
        .await
        .map_err(|e| format!("sessions_save_messages task failed: {e}"))?
}

#[tauri::command]
pub async fn sessions_load_messages(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<serde_json::Value>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || load_session_messages_in_dir(&dir, &id))
        .await
        .map_err(|e| format!("sessions_load_messages task failed: {e}"))?
}

#[tauri::command]
pub async fn sessions_delete_messages(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || delete_session_messages_in_dir(&dir, &id))
        .await
        .map_err(|e| format!("sessions_delete_messages task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn session_store_path_matches_js_encoding() {
        assert_eq!(
            session_store_path("s-abc-123"),
            "termigo-ai-session-s-abc-123.json"
        );
        assert_eq!(
            session_store_path("123456:789"),
            "termigo-ai-session-123456%3A789.json"
        );
        assert_eq!(
            session_store_path("-100123:42"),
            "termigo-ai-session--100123%3A42.json"
        );
        assert_eq!(
            session_store_path("a*b?c<d>e|f.g"),
            "termigo-ai-session-a%2Ab%3Fc%3Cd%3Ee%7Cf%2Eg.json"
        );
    }

    #[test]
    fn migrates_listed_and_orphan_sessions_with_backup() {
        let dir = TempDir::new().unwrap();
        let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
        let legacy = json!({
            "sessions": [{ "id": "s-1", "title": "one" }],
            "activeId": "s-1",
            "runMeta:s-1": { "runRound": 1 },
            "messages:s-1": [{ "id": "m1", "role": "user" }],
            "messages:orphan-99": [{ "id": "m2", "role": "assistant" }],
            "messages:123:456": [{ "id": "m3", "role": "user" }],
        });
        fs::write(&legacy_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let report = migrate_legacy_sessions_in_dir(dir.path()).unwrap();
        assert_eq!(
            report,
            MigrationReport {
                migrated: 3,
                already_migrated: 0,
                backup_created: true,
            }
        );

        // Backup exists and preserves original content
        let bak_path = dir.path().join(LEGACY_BACKUP_FILENAME);
        assert!(bak_path.exists());
        let bak_val: serde_json::Value =
            serde_json::from_slice(&fs::read(&bak_path).unwrap()).unwrap();
        assert_eq!(bak_val, legacy);

        // Compacted legacy store has metadata only, no messages:* keys
        let compacted: serde_json::Value =
            serde_json::from_slice(&fs::read(&legacy_path).unwrap()).unwrap();
        assert_eq!(
            compacted,
            json!({
                "sessions": [{ "id": "s-1", "title": "one" }],
                "activeId": "s-1",
                "runMeta:s-1": { "runRound": 1 },
            })
        );

        // All three sessions (including orphan and colon-keyed) migrated losslessly
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-1").unwrap(),
            Some(json!([{ "id": "m1", "role": "user" }]))
        );
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "orphan-99").unwrap(),
            Some(json!([{ "id": "m2", "role": "assistant" }]))
        );
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "123:456").unwrap(),
            Some(json!([{ "id": "m3", "role": "user" }]))
        );

        // Second run is a no-op and does not create another backup
        let second = migrate_legacy_sessions_in_dir(dir.path()).unwrap();
        assert_eq!(
            second,
            MigrationReport {
                migrated: 0,
                already_migrated: 0,
                backup_created: false,
            }
        );
    }

    #[test]
    fn preserves_newer_per_session_file_and_aborts_if_corrupt() {
        let dir = TempDir::new().unwrap();
        let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
        let legacy = json!({
            "sessions": [{ "id": "s-1" }],
            "messages:s-1": [{ "id": "old" }],
        });
        fs::write(&legacy_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        // Newer per-session file already exists
        save_session_messages_in_dir(dir.path(), "s-1", &json!([{ "id": "newer" }])).unwrap();

        let report = migrate_legacy_sessions_in_dir(dir.path()).unwrap();
        assert_eq!(report.migrated, 0);
        assert_eq!(report.already_migrated, 1);
        assert!(report.backup_created);
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-1").unwrap(),
            Some(json!([{ "id": "newer" }]))
        );

        // Now test corrupt existing per-session file: must abort and NOT delete legacy
        let dir2 = TempDir::new().unwrap();
        let legacy2 = dir2.path().join(LEGACY_STORE_FILENAME);
        fs::write(&legacy2, serde_json::to_vec(&legacy).unwrap()).unwrap();
        fs::write(
            dir2.path().join(session_store_path("s-1")),
            b"{corrupt json",
        )
        .unwrap();

        let err = migrate_legacy_sessions_in_dir(dir2.path()).unwrap_err();
        assert!(err.contains("aborting migration"));
        let still_legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(&legacy2).unwrap()).unwrap();
        assert!(still_legacy.get("messages:s-1").is_some());
        assert!(!dir2.path().join(LEGACY_BACKUP_FILENAME).exists());
    }

    #[test]
    fn aborts_migration_if_existing_session_messages_is_not_an_array() {
        for invalid in [
            json!({ "messages": null }),
            json!({ "messages": "not-an-array" }),
            json!({ "messages": { "a": 1 } }),
            json!({ "messages": 42 }),
            json!({ "other": [] }),
        ] {
            let dir = TempDir::new().unwrap();
            let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
            let legacy = json!({
                "sessions": [{ "id": "s-1" }],
                "messages:s-1": [{ "id": "m1" }],
            });
            fs::write(&legacy_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
            fs::write(
                dir.path().join(session_store_path("s-1")),
                serde_json::to_vec(&invalid).unwrap(),
            )
            .unwrap();

            let err = migrate_legacy_sessions_in_dir(dir.path()).unwrap_err();
            assert!(
                err.contains("aborting migration"),
                "expected abort for {invalid}, got {err}"
            );
            let still_legacy: serde_json::Value =
                serde_json::from_slice(&fs::read(&legacy_path).unwrap()).unwrap();
            assert_eq!(still_legacy, legacy);
            assert!(!dir.path().join(LEGACY_BACKUP_FILENAME).exists());
        }
    }

    #[test]
    fn aborts_without_modifying_legacy_on_truncated_legacy_json() {
        let dir = TempDir::new().unwrap();
        let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
        let truncated = br#"{"sessions":[],"messages:s-1":[{"id":"m1"}],"messages:s-2":[{"#;
        fs::write(&legacy_path, truncated).unwrap();

        let err = migrate_legacy_sessions_in_dir(dir.path()).unwrap_err();
        assert!(err.contains("stream-parse"));
        // Legacy file is untouched
        assert_eq!(fs::read(&legacy_path).unwrap(), truncated);
        assert!(!dir.path().join(LEGACY_BACKUP_FILENAME).exists());
    }

    #[test]
    fn recovers_from_backup_if_sessions_file_missing_after_crash() {
        let dir = TempDir::new().unwrap();
        let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
        let bak_path = dir.path().join(LEGACY_BACKUP_FILENAME);
        let legacy = json!({
            "sessions": [{ "id": "s-1" }],
            "messages:s-1": [{ "id": "m1" }],
        });
        fs::write(&bak_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let report = migrate_legacy_sessions_in_dir(dir.path()).unwrap();
        assert_eq!(report.migrated, 1);
        assert!(legacy_path.exists());
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-1").unwrap(),
            Some(json!([{ "id": "m1" }]))
        );
    }

    #[test]
    fn atomic_save_load_delete_roundtrip() {
        let dir = TempDir::new().unwrap();
        let msgs =
            json!([{ "id": "m1", "role": "user", "parts": [{ "type": "text", "text": "hi" }] }]);
        save_session_messages_in_dir(dir.path(), "s-rw", &msgs).unwrap();
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-rw").unwrap(),
            Some(msgs)
        );
        delete_session_messages_in_dir(dir.path(), "s-rw").unwrap();
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-rw").unwrap(),
            None
        );
    }

    #[test]
    fn recovers_from_in_progress_backup_instead_of_stale_prior_backup() {
        let dir = TempDir::new().unwrap();
        let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
        let stale_bak_path = dir.path().join(LEGACY_BACKUP_FILENAME);
        let in_progress_bak_path = dir.path().join(LEGACY_IN_PROGRESS_BACKUP_FILENAME);

        let stale_legacy = json!({
            "sessions": [{ "id": "s-stale" }],
            "messages:s-stale": [{ "id": "old-msg" }],
        });
        let current_legacy = json!({
            "sessions": [{ "id": "s-current" }],
            "messages:s-current": [{ "id": "new-msg" }],
        });

        fs::write(&stale_bak_path, serde_json::to_vec(&stale_legacy).unwrap()).unwrap();
        fs::write(
            &in_progress_bak_path,
            serde_json::to_vec(&current_legacy).unwrap(),
        )
        .unwrap();

        let report = migrate_legacy_sessions_in_dir(dir.path()).unwrap();
        assert_eq!(report.migrated, 1);
        assert!(report.backup_created);
        assert!(legacy_path.exists());
        assert!(!in_progress_bak_path.exists());

        // Current in-progress backup was recovered and migrated, not the stale one.
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-current").unwrap(),
            Some(json!([{ "id": "new-msg" }]))
        );
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-stale").unwrap(),
            None
        );

        // Stale prior backup remains preserved untouched.
        let stale_val: serde_json::Value =
            serde_json::from_slice(&fs::read(&stale_bak_path).unwrap()).unwrap();
        assert_eq!(stale_val, stale_legacy);
    }

    #[test]
    fn finalizes_in_progress_backup_when_sessions_file_already_persisted() {
        let dir = TempDir::new().unwrap();
        let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
        let bak_path = dir.path().join(LEGACY_BACKUP_FILENAME);
        let in_progress_bak_path = dir.path().join(LEGACY_IN_PROGRESS_BACKUP_FILENAME);

        let compacted = json!({ "sessions": [{ "id": "s-1" }] });
        let original = json!({
            "sessions": [{ "id": "s-1" }],
            "messages:s-1": [{ "id": "m1" }],
        });

        fs::write(&legacy_path, serde_json::to_vec(&compacted).unwrap()).unwrap();
        fs::write(
            &in_progress_bak_path,
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();

        let report = migrate_legacy_sessions_in_dir(dir.path()).unwrap();
        assert_eq!(
            report,
            MigrationReport {
                migrated: 0,
                already_migrated: 0,
                backup_created: false,
            }
        );
        assert!(!in_progress_bak_path.exists());
        assert!(bak_path.exists());
        let archived: serde_json::Value =
            serde_json::from_slice(&fs::read(&bak_path).unwrap()).unwrap();
        assert_eq!(archived, original);
    }

    #[test]
    fn coordinates_concurrent_migration_and_session_io() {
        use std::sync::Arc;
        use std::thread;

        let dir = Arc::new(TempDir::new().unwrap());
        let legacy_path = dir.path().join(LEGACY_STORE_FILENAME);
        let legacy = json!({
            "sessions": [{ "id": "s-1" }, { "id": "s-2" }],
            "messages:s-1": [{ "id": "legacy-1" }],
            "messages:s-2": [{ "id": "legacy-2" }],
        });
        fs::write(&legacy_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        // Pre-save newer messages for s-1 before concurrent threads start.
        let newer = json!([{ "id": "newer-1" }]);
        save_session_messages_in_dir(dir.path(), "s-1", &newer).unwrap();

        let mut handles = Vec::new();
        for i in 0..4 {
            let d = Arc::clone(&dir);
            handles.push(thread::spawn(move || {
                if i % 2 == 0 {
                    migrate_legacy_sessions_in_dir(d.path()).map(|_| ())
                } else {
                    save_session_messages_in_dir(d.path(), "s-3", &json!([{ "id": i }]))?;
                    let _ = load_session_messages_in_dir(d.path(), "s-1")?;
                    Ok(())
                }
            }));
        }

        for h in handles {
            h.join().unwrap().unwrap();
        }

        // Migration must never have overwritten s-1's newer messages.
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-1").unwrap(),
            Some(newer)
        );
        // s-2 from legacy must be migrated.
        assert_eq!(
            load_session_messages_in_dir(dir.path(), "s-2").unwrap(),
            Some(json!([{ "id": "legacy-2" }]))
        );
    }
}
