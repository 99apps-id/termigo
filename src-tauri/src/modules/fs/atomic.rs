//! Crash-safe file writes: stage into a sibling temp file, fsync, then
//! rename over the target.
//!
//! A torn write (crash / power loss between `open` and the last byte) would
//! otherwise leave a half-written file. Several callers persist data whose
//! readers fall back to defaults on a parse error, so a torn write would
//! silently wipe user state - worth the extra fsync to avoid.
//!
//! The temp file is created in the SAME directory as the target so the final
//! `rename` is same-filesystem (atomic) and never a cross-device copy. On any
//! failure the temp is removed best-effort so a crash mid-write does not leave
//! a stray `.tmp` behind.
//!
//! The staging name is randomised per write and opened with `O_EXCL`, so a
//! symlink planted at a predictable staging path cannot redirect the write
//! (a fixed name would let it point the write at - and truncate - the link's
//! target). Callers that need a specific final byte stream (DPAPI-encrypted,
//! 0600 perms, pretty-printed JSON) compose AROUND this: produce the bytes,
//! then call [`atomic_write`]. This helper owns only the staging/rename
//! mechanics, never the encoding.

use std::fs;
use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Atomically replace `path` with `bytes`.
///
/// Stages into a randomised sibling temp, fsyncs it, then renames over `path`.
/// Removes the temp on any failure. Returns the underlying [`io::Error`] so
/// callers can map it to their own error type.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_staged(path, bytes, |tmp| {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(tmp)
    })
}

/// Unix-only [`atomic_write`] variant that creates the staging temp with the
/// given permission `mode` BEFORE any bytes are written, so the contents are
/// never briefly world-readable. Used for the Linux secrets file (mode
/// `0o600`) where the plaintext must never touch disk with loose perms.
#[cfg(unix)]
pub fn atomic_write_mode(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    write_staged(path, bytes, move |tmp| {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(tmp)
    })
}

/// A per-write randomised staging path in `parent`. The nonce mixes the pid, a
/// monotonic-ish clock and a process-wide counter, so the name is not
/// predictable enough to plant a symlink at; combined with the `create_new`
/// open it also fails closed if the name does happen to exist.
fn staging_path(parent: &Path, file_name: &OsStr) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut name = std::ffi::OsString::from(".");
    name.push(file_name);
    name.push(format!(".{}.{}.{}.termigo.tmp", std::process::id(), nanos, n));
    parent.join(name)
}

/// Stage `bytes` into a randomised sibling temp (opened via `open_tmp`), fsync,
/// then rename over `path`. Removes the temp on any failure.
fn write_staged<F>(path: &Path, bytes: &[u8], open_tmp: F) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<fs::File>,
{
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;

    // Temp lives beside the target so `rename` stays on one filesystem.
    let tmp = staging_path(parent, file_name);

    // Wrap the body so a single `?` short-circuit funnels through the cleanup
    // below; we must not leave the staged temp behind on failure.
    let result = (|| -> io::Result<()> {
        let mut f = open_tmp(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        // Drop the handle before renaming: Windows refuses to rename a file
        // with an open handle in some configurations.
        drop(f);
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_overwrites_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        std::fs::write(&target, b"old").unwrap();
        atomic_write(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    // A symlink pre-planted at the legacy deterministic staging name must not be
    // followed: the write must land on the target, not truncate the link's
    // target through it.
    #[cfg(unix)]
    #[test]
    fn does_not_follow_pre_staged_staging_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();
        symlink(&outside, dir.path().join(".settings.json.termigo.tmp")).unwrap();

        atomic_write(&target, b"payload").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_mode_sets_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("secret.json");
        atomic_write_mode(&target, b"x", 0o600).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
