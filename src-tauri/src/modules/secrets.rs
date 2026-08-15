//! Secret storage with platform-appropriate backends.
//!
//! - macOS: macOS Keychain (via `keyring` crate)
//! - Windows: Credential Manager (via `keyring` crate)
//! - Linux: a file in the app's local data dir, mode 0600. The default
//!   `keyring` backend on Linux is the Secret Service over D-Bus, which
//!   silently fails on systems without gnome-keyring/kwallet (and on the
//!   "login" collection not being created). For an open-source desktop
//!   app shipped via AppImage/deb/rpm, we cannot assume a keyring daemon
//!   exists. The file backend is the same approach Brave/Chromium fall
//!   back to in that scenario; user-only file permissions provide the
//!   isolation the secret-service collection would have otherwise.
//!
//! The frontend talks to `secrets_get`, `secrets_set`, `secrets_delete`,
//! and `secrets_get_all` — no platform branching in JS.
//!
//! All commands take `&AppHandle` so we can resolve the data directory
//! once via Tauri's path API.

use std::sync::Mutex;

use tauri::AppHandle;

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[derive(Default)]
pub struct SecretsState {
    #[cfg(target_os = "linux")]
    cache: Mutex<Option<HashMap<String, String>>>,
    #[cfg(not(target_os = "linux"))]
    _phantom: Mutex<()>,
}

#[cfg(target_os = "linux")]
pub(crate) fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

#[cfg(target_os = "linux")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[cfg(target_os = "linux")]
fn read_store(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    read_store_at(&store_path(app)?)
}

#[cfg(target_os = "linux")]
pub(crate) fn read_store_at(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<HashMap<String, String>>(&bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn write_store(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    write_store_at(&store_path(app)?, map)
}

#[cfg(target_os = "linux")]
pub(crate) fn write_store_at(
    path: &std::path::Path,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;

    // 0600: only the owning user can read or write the secrets file.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn with_store<F, R>(app: &AppHandle, state: &SecretsState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut HashMap<String, String>) -> R,
{
    let mut guard = state.cache.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(read_store(app)?);
    }
    let map = guard.as_mut().expect("cache initialized above");
    Ok(f(map))
}

#[cfg(not(target_os = "linux"))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Oversized values
//
// Windows Credential Manager caps one credential blob at
// CRED_MAX_CREDENTIAL_BLOB_SIZE (2560 bytes), and the keyring crate stores the
// password as UTF-16, so the real ceiling is 1280 code units. That is under an
// RSA-2048 private key (~1.7 KB of PEM) and well under RSA-4096 (~3.2 KB), so
// importing a .pem failed outright with "longer than platform limit of 2560
// chars".
//
// Values past the ceiling are split across numbered companion entries, with the
// primary entry holding a header saying how many to read back. Short values are
// still stored verbatim in a single entry, so everything written before this
// existed keeps reading fine.
//
// The macOS Keychain has no comparable limit, but it runs the same path: one
// code path that is exercised on every platform beats a second one that only
// Windows ever executes.
// ---------------------------------------------------------------------------

/// Stay well under the 1280 UTF-16 ceiling; the margin costs one extra entry
/// per ~4 KB of secret and buys room for whatever a future backend charges for
/// framing.
#[cfg(any(not(target_os = "linux"), test))]
const MAX_CHUNK_UTF16: usize = 1000;

/// Marker stored in the primary entry when the value lives in chunks.
///
/// The leading NUL is what makes this unambiguous: an API key, a PEM, or a
/// passphrase cannot contain one, so a real secret can never be misread as a
/// header. Both backends store the blob with an explicit length rather than
/// NUL-terminating it, so the byte survives the round trip.
#[cfg(any(not(target_os = "linux"), test))]
const CHUNK_HEADER: &str = "\u{0}termigo-chunked-v1:";

#[cfg(any(not(target_os = "linux"), test))]
fn chunk_header(count: usize) -> String {
    format!("{CHUNK_HEADER}{count}")
}

/// `Some(count)` when this value is a header rather than a secret.
#[cfg(any(not(target_os = "linux"), test))]
fn parse_chunk_header(value: &str) -> Option<usize> {
    value.strip_prefix(CHUNK_HEADER)?.parse().ok()
}

/// Companion entry name. No NUL here: on Windows the target name is a
/// NUL-terminated wide string, so an embedded NUL would truncate it.
#[cfg(any(not(target_os = "linux"), test))]
fn chunk_account(account: &str, index: usize) -> String {
    format!("{account}__termigo_chunk_{index}")
}

/// Split on char boundaries while counting UTF-16 units, which is what the
/// platform limit is measured in. Counting bytes would overshoot for non-ASCII
/// passphrases; splitting on UTF-16 indices directly could tear a surrogate
/// pair and corrupt the value.
#[cfg(any(not(target_os = "linux"), test))]
fn split_chunks(value: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut units = 0usize;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if units + width > MAX_CHUNK_UTF16 && !current.is_empty() {
            out.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(ch);
        units += width;
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let _ = state; // capture
        let key = key(&service, &account);
        with_store(&app, &state, |m| m.get(&key).cloned())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        read_entry(&service, &account)
    }
}

/// Read one logical value, reassembling it when it was stored in chunks.
#[cfg(not(target_os = "linux"))]
fn read_entry(service: &str, account: &str) -> Result<Option<String>, String> {
    let head = match entry(service, account)?.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let Some(count) = parse_chunk_header(&head) else {
        return Ok(Some(head)); // stored verbatim, including everything pre-chunking
    };

    let mut out = String::new();
    for i in 0..count {
        let part = entry(service, &chunk_account(account, i))?;
        match part.get_password() {
            Ok(v) => out.push_str(&v),
            // A missing chunk means a half-written or half-deleted secret.
            // Returning the fragment would hand out a truncated private key and
            // fail later as an unexplained auth error, so refuse instead.
            Err(keyring::Error::NoEntry) => {
                return Err(format!(
                    "stored secret is incomplete: chunk {} of {count} is missing",
                    i + 1
                ));
            }
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(Some(out))
}

/// Remove the companion entries a previous chunked write left behind.
#[cfg(not(target_os = "linux"))]
fn delete_chunks(service: &str, account: &str) -> Result<(), String> {
    let head = match entry(service, account)?.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(_) => return Ok(()), // nothing readable to clean up after
    };
    let Some(count) = parse_chunk_header(&head) else {
        return Ok(());
    };
    for i in 0..count {
        let part = entry(service, &chunk_account(account, i))?;
        match part.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let key = key(&service, &account);
        with_store(&app, &state, |m| {
            m.insert(key, password);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        // Clear the old layout first: overwriting a 4-chunk value with a
        // 2-chunk one would otherwise strand chunks 2 and 3, and a later
        // longer write would read them back as part of the new secret.
        delete_chunks(&service, &account)?;

        let chunks = split_chunks(&password);
        if chunks.len() <= 1 {
            return entry(&service, &account)?
                .set_password(&password)
                .map_err(|e| e.to_string());
        }
        // Chunks first, header last: if this is interrupted, the primary entry
        // still holds the previous value or nothing, never a header pointing at
        // chunks that were never written.
        for (i, part) in chunks.iter().enumerate() {
            entry(&service, &chunk_account(&account, i))?
                .set_password(part)
                .map_err(|e| e.to_string())?;
        }
        entry(&service, &account)?
            .set_password(&chunk_header(chunks.len()))
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let key = key(&service, &account);
        with_store(&app, &state, |m| {
            m.remove(&key);
        })?;
        let snapshot = {
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            guard.as_ref().cloned().unwrap_or_default()
        };
        write_store(&app, &snapshot)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        // Companions first: the header is what finds them, so dropping it
        // early would leak them permanently.
        delete_chunks(&service, &account)?;
        match entry(&service, &account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::*;

    fn rejoin(parts: &[String]) -> String {
        parts.concat()
    }

    #[test]
    fn short_values_are_not_split() {
        assert_eq!(split_chunks("sk-test-key").len(), 1);
    }

    #[test]
    fn empty_value_produces_no_chunks() {
        assert!(split_chunks("").is_empty());
    }

    #[test]
    fn every_chunk_fits_the_platform_ceiling() {
        // An RSA-4096 PEM is around this size, and is the case that failed.
        let pem = "A".repeat(3300);
        let parts = split_chunks(&pem);
        assert!(parts.len() > 1, "an RSA-4096 PEM must be split");
        for p in &parts {
            assert!(
                p.encode_utf16().count() <= MAX_CHUNK_UTF16,
                "chunk of {} units exceeds the ceiling",
                p.encode_utf16().count()
            );
        }
        assert_eq!(rejoin(&parts), pem, "splitting must be lossless");
    }

    #[test]
    fn a_real_pem_round_trips_byte_for_byte() {
        let pem = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n",
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB".repeat(60)
        );
        assert_eq!(rejoin(&split_chunks(&pem)), pem);
    }

    // Counting bytes instead of UTF-16 units would overshoot the limit here,
    // and slicing by UTF-16 index would tear a surrogate pair in half.
    #[test]
    fn multibyte_and_astral_characters_survive_splitting() {
        let value = "é🔑".repeat(900);
        let parts = split_chunks(&value);
        for p in &parts {
            assert!(p.encode_utf16().count() <= MAX_CHUNK_UTF16);
        }
        assert_eq!(rejoin(&parts), value);
    }

    #[test]
    fn header_round_trips() {
        assert_eq!(parse_chunk_header(&chunk_header(7)), Some(7));
    }

    // The whole scheme rests on this: a stored secret must never be mistaken
    // for a header and read back as an empty string.
    #[test]
    fn ordinary_secrets_are_never_read_as_headers() {
        for value in [
            "sk-ant-api03-abc",
            "-----BEGIN RSA PRIVATE KEY-----",
            "termigo-chunked-v1:3",
            "\u{0}",
            "",
            "hunter2",
        ] {
            assert_eq!(parse_chunk_header(value), None, "misread {value:?}");
        }
    }

    #[test]
    fn chunk_accounts_are_distinct_and_free_of_nul() {
        let a = chunk_account("conn-1-privateKey", 0);
        let b = chunk_account("conn-1-privateKey", 1);
        assert_ne!(a, b);
        assert!(!a.contains('\u{0}'), "a NUL would truncate the target name");
        assert!(a.starts_with("conn-1-privateKey"));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use tempfile::TempDir;

    #[test]
    fn key_format_is_service_double_colon_account() {
        assert_eq!(key("openai", "alice"), "openai::alice");
        assert_eq!(key("", ""), "::");
    }

    #[test]
    fn read_store_at_missing_path_is_empty() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nope.json");
        let map = read_store_at(&p).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        let mut m = HashMap::new();
        m.insert(key("svc", "alice"), "p1".into());
        m.insert(key("svc", "bob"), "p2".into());

        write_store_at(&p, &m).unwrap();
        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, m);
    }

    #[test]
    fn write_uses_mode_0600() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let mode = fs::metadata(&p).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "secrets file must be user-only readable");
    }

    #[test]
    fn write_does_not_leave_tmp_file_on_success() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let tmp_path = p.with_extension("json.tmp");
        assert!(!tmp_path.exists(), "tmp file must be renamed away on success");
    }

    #[test]
    fn write_overwrites_existing_atomically() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");

        let mut first = HashMap::new();
        first.insert("a".into(), "1".into());
        write_store_at(&p, &first).unwrap();

        let mut second = HashMap::new();
        second.insert("b".into(), "2".into());
        write_store_at(&p, &second).unwrap();

        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, second);
        assert!(!loaded.contains_key("a"));
    }

    #[test]
    fn read_store_at_garbage_file_errors() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        fs::write(&p, b"not json").unwrap();
        assert!(read_store_at(&p).is_err());
    }
}

/// Batch read — single IPC roundtrip for the cold-boot fan-out.
#[tauri::command]
pub async fn secrets_get_all(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    #[cfg(target_os = "linux")]
    {
        with_store(&app, &state, |m| {
            accounts
                .iter()
                .map(|a| m.get(&key(&service, a)).cloned())
                .collect()
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        // One unreadable account must not fail the whole cold-boot fan-out, so
        // an error here degrades to None exactly as a missing entry does.
        Ok(accounts
            .into_iter()
            .map(|a| read_entry(&service, &a).ok().flatten())
            .collect())
    }
}
