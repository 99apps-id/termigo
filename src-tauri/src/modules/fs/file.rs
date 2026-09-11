use std::path::Path;
use std::time::UNIX_EPOCH;
use std::{fs, io::Write};

use serde::Serialize;
use tauri::Emitter;
use tempfile::NamedTempFile;

use super::security::{guard_read, guard_write};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// Ceiling for explicit "open anyway"; mirrored as FORCE_READ_LIMIT in useDocument.ts.
const FORCE_MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const MAX_WRITE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB
const MAX_WRITE_BASE64_BYTES: u64 = 50 * 1024 * 1024; // 50 MB decoded

#[derive(Serialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
        mtime: u64,
    },
    Binary {
        size: u64,
    },
    /// File exceeds MAX_READ_BYTES. UI decides whether to offer "open anyway".
    TooLarge {
        size: u64,
        limit: u64,
    },
}

/// Cap for image reads fed to a vision model: large enough for a screenshot or
/// design mock, small enough to keep the base64 payload and token cost sane.
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
pub struct ImageReadResult {
    /// IANA media type, sniffed from magic bytes (falls back to the extension).
    pub media_type: String,
    /// Base-64 (standard) encoded image bytes.
    pub data: String,
    pub size: u64,
}

/// Sniff an image's media type from its magic bytes, falling back to the file
/// extension. Returns None for anything that is not a supported raster image, so
/// the caller can refuse non-images before base64-encoding a huge blob.
fn image_media_type(bytes: &[u8], path: &Path) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // No magic match: trust the extension for formats a vision model accepts.
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

#[tauri::command]
pub async fn fs_read_image_base64(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<ImageReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = guard_read(&resolve_path(&path, &workspace))?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let size = meta.len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "image too large ({size} bytes, limit {MAX_IMAGE_BYTES})"
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let media_type = image_media_type(&bytes, &p)
        .ok_or("not a supported image (expected png, jpeg, gif or webp)")?;
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ImageReadResult {
        media_type: media_type.to_string(),
        data,
        size,
    })
}

/// Cap for arbitrary-file base64 reads (used to send a report to Telegram).
const MAX_FILE_BASE64_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileReadBase64 {
    /// IANA media type, guessed from the extension (or octet-stream).
    pub media_type: String,
    /// Base-64 (standard) encoded file bytes.
    pub data: String,
    pub size: u64,
    /// File name (basename) used as the Telegram document name.
    pub file_name: String,
}

fn file_media_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("pdf") => "application/pdf",
        Some("html") | Some("htm") => "text/html",
        Some("md") | Some("markdown") => "text/markdown",
        Some("txt") => "text/plain",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Read any file as base-64 so the webview can upload it (e.g. a PDF report)
/// to Telegram. Unlike `fs_read_image_base64` it does not require an image.
#[tauri::command]
pub async fn fs_read_file_base64(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<FileReadBase64, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = guard_read(&resolve_path(&path, &workspace))?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let size = meta.len();
    if size > MAX_FILE_BASE64_BYTES {
        return Err(format!(
            "file too large ({size} bytes, limit {MAX_FILE_BASE64_BYTES})"
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    Ok(FileReadBase64 {
        media_type: file_media_type(&p),
        data,
        size,
        file_name,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
    pub kind: StatKind,
}

fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn fs_read_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    force: Option<bool>,
) -> Result<ReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let resolved = guard_read(&resolve_path(&path, &workspace))?;
    read_file_sync(&resolved, force.unwrap_or(false))
}

fn read_file_sync(p: &Path, force: bool) -> Result<ReadResult, String> {
    let meta = std::fs::metadata(p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    if meta.is_dir() {
        return Err(format!("'{}' is a directory, not a file", p.display()));
    }

    let size = meta.len();
    let limit = if force {
        FORCE_MAX_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    if size > limit {
        return Ok(ReadResult::TooLarge { size, limit });
    }

    let bytes = std::fs::read(p).map_err(|e| {
        log::debug!("fs_read_file read({}) failed: {e}", p.display());
        e.to_string()
    })?;

    // Support UTF-16 with BOM for text files (common with Windows PowerShell)
    if is_likely_text_file(p, &bytes) {
        if let Some(content) = try_decode_utf16(&bytes) {
            return Ok(ReadResult::Text {
                content,
                size,
                mtime: mtime_millis(&meta),
            });
        }
    }

    // Null-byte sniff on the first chunk. Catches the common
    // "this is a PNG / EXE" mistake cheaply.
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return Ok(ReadResult::Binary { size });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text {
            content,
            size,
            mtime: mtime_millis(&meta),
        }),
        Err(e) => {
            let raw = e.into_bytes();
            if is_likely_text_file(p, &raw) {
                let content = decode_fallback_text(&raw);
                Ok(ReadResult::Text {
                    content,
                    size,
                    mtime: mtime_millis(&meta),
                })
            } else {
                Ok(ReadResult::Binary { size })
            }
        }
    }
}

fn try_decode_utf16(bytes: &[u8]) -> Option<String> {
    if bytes.len() >= 2 && bytes.starts_with(&[0xFF, 0xFE]) {
        let payload = &bytes[2..];
        let mut u16_chars = Vec::with_capacity(payload.len() / 2);
        let mut i = 0;
        while i + 1 < payload.len() {
            u16_chars.push(u16::from_le_bytes([payload[i], payload[i + 1]]));
            i += 2;
        }
        String::from_utf16(&u16_chars).ok()
    } else if bytes.len() >= 2 && bytes.starts_with(&[0xFE, 0xFF]) {
        let payload = &bytes[2..];
        let mut u16_chars = Vec::with_capacity(payload.len() / 2);
        let mut i = 0;
        while i + 1 < payload.len() {
            u16_chars.push(u16::from_be_bytes([payload[i], payload[i + 1]]));
            i += 2;
        }
        String::from_utf16(&u16_chars).ok()
    } else {
        None
    }
}

fn is_likely_text_file(path: &Path, bytes: &[u8]) -> bool {
    if let Some(ext) = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
        match ext.as_str() {
            "txt" | "md" | "markdown" | "json" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx"
            | "css" | "scss" | "less" | "html" | "htm" | "xml" | "svg" | "yaml" | "yml"
            | "toml" | "ini" | "conf" | "cfg" | "sh" | "bash" | "zsh" | "fish" | "ps1"
            | "bat" | "cmd" | "py" | "rs" | "go" | "c" | "cpp" | "h" | "hpp" | "java" | "kt"
            | "php" | "rb" | "sql" | "log" | "env" | "csv" | "tsv" | "rules" | "diff"
            | "patch" => {
                return true;
            }
            _ => {}
        }
    }

    if bytes.is_empty() {
        return true;
    }

    let sample_len = bytes.len().min(4096);
    let sample = &bytes[..sample_len];
    let printable_or_ws = sample
        .iter()
        .filter(|&&b| b == b'\t' || b == b'\n' || b == b'\r' || (0x20..=0x7E).contains(&b))
        .count();
    (printable_or_ws as f64 / sample_len as f64) >= 0.80
}

fn decode_fallback_text(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if b < 0x80 {
            out.push(b as char);
        } else if (0x80..=0x9F).contains(&b) {
            let ch = match b {
                0x80 => '€',
                0x82 => '‚',
                0x83 => 'ƒ',
                0x84 => '„',
                0x85 => '…',
                0x86 => '†',
                0x87 => '‡',
                0x88 => 'ˆ',
                0x89 => '‰',
                0x8A => 'Š',
                0x8B => '‹',
                0x8C => 'Œ',
                0x8E => 'Ž',
                0x91 => '‘',
                0x92 => '’',
                0x93 => '“',
                0x94 => '”',
                0x95 => '•',
                0x96 => '–',
                0x97 => '—',
                0x98 => '˜',
                0x99 => '™',
                0x9A => 'š',
                0x9B => '›',
                0x9C => 'œ',
                0x9E => 'ž',
                0x9F => 'Ÿ',
                _ => '?',
            };
            out.push(ch);
        } else {
            out.push(char::from_u32(b as u32).unwrap_or('?'));
        }
    }
    out
}

#[derive(Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// Atomic write via O_EXCL tempfile in the target's parent, then rename.
/// The random suffix is what blocks pre-staged symlink attacks.
fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    // Create the parent directory tree so writing "reports/out.html" into a
    // folder that does not exist yet succeeds instead of failing with a bare
    // "the system cannot find the file specified (os error 2)".
    if !parent.as_os_str().is_empty() && !parent.exists() {
        fs::create_dir_all(parent)?;
    }
    match NamedTempFile::new_in(parent) {
        Ok(mut tmp) => {
            tmp.as_file_mut().write_all(content)?;
            tmp.as_file_mut().sync_all()?;
            match tmp.persist(target) {
                Ok(_) => Ok(()),
                Err(persist_err) => {
                    log::debug!(
                        "write_atomic persist({}) failed ({}), falling back to direct write",
                        target.display(),
                        persist_err.error
                    );
                    fs::write(target, content)
                }
            }
        }
        Err(e) => {
            log::debug!(
                "write_atomic new_in({}) failed ({e}), falling back to direct write",
                parent.display()
            );
            fs::write(target, content)
        }
    }
}

/// Returns the new mtime so the editor can track disk state for conflict
/// detection without a follow-up stat.
#[tauri::command]
pub async fn fs_write_file(
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let content_len = content.len() as u64;
    if content_len > MAX_WRITE_BYTES {
        return Err(format!(
            "write refused: {} bytes exceeds limit {MAX_WRITE_BYTES}",
            content_len
        ));
    }

    let workspace = WorkspaceEnv::from_option(workspace);
    let target = guard_write(&resolve_path(&path, &workspace))?;
    let original_permissions = fs::metadata(&target).ok().map(|m| m.permissions());
    write_atomic(&target, content.as_bytes()).map_err(|e| {
        log::warn!("fs_write_file({}) failed: {e}", target.display());
        e.to_string()
    })?;

    if let Some(perms) = original_permissions {
        let _ = fs::set_permissions(&target, perms);
    }
    let mtime = fs::metadata(&target).map(|m| mtime_millis(&m)).unwrap_or(0);
    let _ = app.emit(
        "fs:file-written",
        FileWrittenEvent {
            path: path.clone(),
            source,
        },
    );

    Ok(mtime)
}

#[tauri::command]
pub async fn fs_write_file_base64(
    path: String,
    data: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let decoded_len = data.len() as u64;
    if decoded_len > MAX_WRITE_BASE64_BYTES {
        return Err(format!(
            "write refused: base64 input {} bytes exceeds limit {MAX_WRITE_BASE64_BYTES}",
            decoded_len
        ));
    }

    let workspace = WorkspaceEnv::from_option(workspace);
    let target = guard_write(&resolve_path(&path, &workspace))?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("invalid base64: {e}"))?;
    write_atomic(&target, &bytes).map_err(|e| {
        log::warn!("fs_write_file_base64({}) failed: {e}", target.display());
        e.to_string()
    })?;
    let mtime = fs::metadata(&target).map(|m| mtime_millis(&m)).unwrap_or(0);
    let _ = app.emit(
        "fs:file-written",
        FileWrittenEvent {
            path: path.clone(),
            source,
        },
    );
    Ok(mtime)
}

#[tauri::command]
pub async fn fs_canonicalize(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = guard_read(&resolve_path(&path, &workspace))?;
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    Ok(super::to_canon(&canon))
}

#[tauri::command]
pub async fn fs_stat(path: String, workspace: Option<WorkspaceEnv>) -> Result<FileStat, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    // fs::metadata follows symlinks, so the link check needs symlink_metadata.
    let kind = if std::fs::symlink_metadata(&p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        StatKind::Symlink
    } else if meta.is_dir() {
        StatKind::Dir
    } else {
        StatKind::File
    };
    Ok(FileStat {
        size: meta.len(),
        mtime: mtime_millis(&meta),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_file_classifies_utf8_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"hello world").unwrap();
        match read_file_sync(&f, false).unwrap() {
            ReadResult::Text {
                content,
                size,
                mtime,
            } => {
                assert_eq!(content, "hello world");
                assert_eq!(size, 11);
                assert!(mtime > 0);
            }
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn file_base64_media_type_and_name() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("report.pdf");
        std::fs::write(&f, b"%PDF-1.4 fake").unwrap();
        assert_eq!(file_media_type(&f), "application/pdf");
        assert_eq!(f.file_name().and_then(|n| n.to_str()), Some("report.pdf"));
        let bytes = std::fs::read(&f).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(base64::engine::general_purpose::STANDARD.encode(&bytes))
                .unwrap(),
            bytes
        );
    }

    #[test]
    fn read_file_detects_binary_via_null_byte() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"PNG\0\x89image").unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn read_file_detects_binary_via_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        // Invalid UTF-8 with no null byte: must still classify as binary.
        std::fs::write(&f, [0xff, 0xfe, 0xfd, 0xfc]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn read_file_reads_windows_1252_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("memory.md");
        // Windows-1252 em-dash (0x97) in markdown text
        let mut bytes = b"## 2026-08-18 -- App blank\n".to_vec();
        bytes[14] = 0x97; // replace with Windows-1252 em-dash
        std::fs::write(&f, bytes).unwrap();
        let res = read_file_sync(&f, false).unwrap();
        match res {
            ReadResult::Text { content, .. } => {
                assert!(content.contains("App blank"));
                assert!(content.contains('—'));
            }
            _ => panic!("expected ReadResult::Text for windows-1252 markdown file"),
        }
    }

    #[test]
    fn read_file_reads_utf16_le_bom_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("output.txt");
        // UTF-16 LE BOM + "hello"
        let mut bytes = vec![0xFF, 0xFE];
        for ch in "hello\n".encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        std::fs::write(&f, bytes).unwrap();
        let res = read_file_sync(&f, false).unwrap();
        match res {
            ReadResult::Text { content, .. } => {
                assert_eq!(content, "hello\n");
            }
            _ => panic!("expected ReadResult::Text for UTF-16 LE BOM text file"),
        }
    }

    #[test]
    fn force_lifts_the_default_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("big.txt");
        std::fs::write(&f, vec![b'a'; (MAX_READ_BYTES + 1) as usize]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::TooLarge { .. }
        ));
        assert!(matches!(
            read_file_sync(&f, true).unwrap(),
            ReadResult::Text { .. }
        ));
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn read_file_refuses_directory_with_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_file_sync(dir.path(), false).unwrap_err();
        assert!(err.contains("is a directory, not a file"));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_legacy_staging_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();

        let target = dir.path().join("note.txt");
        // Pre-stage a symlink at the legacy deterministic staging path.
        let legacy = dir.path().join(".note.txt.termigo.tmp");
        symlink(&outside, &legacy).unwrap();

        write_atomic(&target, b"payload").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        // The pre-staged symlink target must not have been written through.
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }
}
