use super::security::{guard_read, guard_write};
use crate::modules::workspace::{
    require_authorized, resolve_path, WorkspaceEnv, WorkspaceRegistry,
};

/// Creates a new empty file. Fails if the file already exists.
#[tauri::command]
pub fn fs_create_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    create_file_inner(&registry, path, workspace)
}

fn create_file_inner(
    registry: &WorkspaceRegistry,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = guard_write(&resolve_path(&path, &workspace))?;
    require_authorized(registry, &p)?;
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::write(&p, "").map_err(|e| {
        log::debug!("fs_create_file({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Creates a new directory. Fails if the directory already exists.
/// Parents are created as needed — matches the common "new folder" UX
/// where typing "a/b/c" creates the full chain.
#[tauri::command]
pub fn fs_create_dir(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    create_dir_inner(&registry, path, workspace)
}

fn create_dir_inner(
    registry: &WorkspaceRegistry,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = guard_write(&resolve_path(&path, &workspace))?;
    require_authorized(registry, &p)?;
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| {
        log::debug!("fs_create_dir({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Renames (or moves) a path. Refuses to overwrite an existing target.
#[tauri::command]
pub fn fs_rename(
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    rename_inner(&registry, from, to, workspace)
}

fn rename_inner(
    registry: &WorkspaceRegistry,
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let from_p = resolve_path(&from, &workspace);
    let to_p = resolve_path(&to, &workspace);
    super::security::validate_read(&from_p)?;
    super::security::validate_write(&to_p)?;
    require_authorized(registry, &from_p)?;
    require_authorized(registry, &to_p)?;
    if !from_p.exists() {
        return Err(format!("not found: {}", from_p.display()));
    }
    if to_p.exists() {
        return Err(format!("already exists: {}", to_p.display()));
    }
    if let Err(e) = std::fs::rename(&from_p, &to_p) {
        if from_p.is_file() {
            std::fs::copy(&from_p, &to_p)
                .and_then(|_| std::fs::remove_file(&from_p))
                .map_err(|copy_err| {
                    log::debug!(
                        "fs_rename copy-fallback({} -> {}) failed: {copy_err}",
                        from_p.display(),
                        to_p.display()
                    );
                    copy_err.to_string()
                })?;
            return Ok(());
        }
        log::debug!(
            "fs_rename({} -> {}) failed: {e}",
            from_p.display(),
            to_p.display()
        );
        return Err(e.to_string());
    }
    Ok(())
}

/// Deletes a file or directory (recursively for dirs). Callers are
/// responsible for confirming destructive operations with the user.
#[tauri::command]
pub fn fs_delete(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    delete_inner(&registry, path, workspace)
}

fn delete_inner(
    registry: &WorkspaceRegistry,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = resolve_path(&path, &workspace);
    super::security::validate_write(&p)?;
    require_authorized(registry, &p)?;
    let meta = std::fs::symlink_metadata(&p).map_err(|e| {
        log::debug!("fs_delete stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let result = if meta.is_dir() {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_file(&p)
    };

    result.map_err(|e| {
        log::warn!("fs_delete({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Copies a file or directory tree **without following symlinks**. Every child
/// is re-checked against the deny-list, so a top-level source that passed the
/// guard cannot smuggle a nested `.env`/`id_rsa` in, and a link pointing at
/// `~/.ssh` (or `/etc`) is skipped instead of copied by target.
fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    if file_type.is_dir() {
        std::fs::create_dir(dst).map_err(|e| e.to_string())?;
        let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            // Skip entries the deny-list refuses rather than failing the whole
            // copy: a nested `.env`/`.ssh` must not be duplicated in, but it
            // also must not abort an otherwise-valid drag-and-drop.
            if super::security::check_readable(&entry.path().to_string_lossy()).is_err() {
                continue;
            }
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Copies external files/dirs into a destination directory, recursively for
/// dirs. Sources are absolute OS paths (from a drag-drop); only the destination
/// is workspace-resolved. Refuses to overwrite existing entries.
#[tauri::command]
pub fn fs_copy(
    sources: Vec<String>,
    dest_dir: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    copy_inner(&registry, sources, dest_dir, workspace)
}

fn copy_inner(
    registry: &WorkspaceRegistry,
    sources: Vec<String>,
    dest_dir: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let dest = guard_write(&resolve_path(&dest_dir, &workspace))?;
    require_authorized(registry, &dest)?;
    for source in &sources {
        let src = guard_read(std::path::Path::new(source))?;
        let name = src
            .file_name()
            .ok_or_else(|| format!("invalid source: {source}"))?;
        let target = guard_write(&dest.join(name))?;
        if target.exists() {
            return Err(format!("already exists: {}", target.display()));
        }
        copy_recursive(&src, &target).map_err(|e| {
            log::warn!(
                "fs_copy({} -> {}) failed: {e}",
                src.display(),
                target.display()
            );
            e
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: std::path::PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    /// A registry authorizing `dir`, mirroring how the app authorizes a
    /// workspace root at runtime, so the command inner fns accept the fixture.
    fn reg_for(dir: &std::path::Path) -> WorkspaceRegistry {
        let reg = WorkspaceRegistry::default();
        reg.authorize(std::fs::canonicalize(dir).unwrap())
            .expect("authorize");
        reg
    }

    #[test]
    fn create_file_makes_empty_and_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let reg = reg_for(dir.path());
        let f = dir.path().join("new.txt");
        create_file_inner(&reg, s(f.clone()), None).expect("create");
        assert!(f.exists());
        assert_eq!(std::fs::read(&f).unwrap(), b"");

        // A second create must error, not truncate existing content.
        std::fs::write(&f, b"data").unwrap();
        let err = create_file_inner(&reg, s(f.clone()), None).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&f).unwrap(), b"data");
    }

    #[test]
    fn create_dir_builds_nested_chain_and_refuses_existing() {
        let dir = tempfile::tempdir().unwrap();
        let reg = reg_for(dir.path());
        let nested = dir.path().join("a/b/c");
        create_dir_inner(&reg, s(nested.clone()), None).expect("create dir");
        assert!(nested.is_dir());
        let err = create_dir_inner(&reg, s(nested), None).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn rename_moves_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let reg = reg_for(dir.path());
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        std::fs::write(&from, b"payload").unwrap();

        rename_inner(&reg, s(from.clone()), s(to.clone()), None).expect("rename");
        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"payload");

        // Missing source is reported, not silently ignored.
        let err = rename_inner(&reg, s(from), s(dir.path().join("c.txt")), None).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");

        // Refusing to overwrite an existing target is the data-loss guard.
        let occupied = dir.path().join("keep.txt");
        std::fs::write(&occupied, b"keep").unwrap();
        let err = rename_inner(&reg, s(to.clone()), s(occupied.clone()), None).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"keep");
        assert!(to.exists());
    }

    #[test]
    fn copy_brings_file_and_dir_in_and_refuses_clobber() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let reg = reg_for(dest.path());
        std::fs::write(src.path().join("a.txt"), b"payload").unwrap();
        std::fs::create_dir_all(src.path().join("d/inner")).unwrap();
        std::fs::write(src.path().join("d/inner/y.txt"), b"y").unwrap();

        copy_inner(
            &reg,
            vec![s(src.path().join("a.txt")), s(src.path().join("d"))],
            s(dest.path().to_path_buf()),
            None,
        )
        .expect("copy");

        assert_eq!(
            std::fs::read(dest.path().join("a.txt")).unwrap(),
            b"payload"
        );
        assert_eq!(
            std::fs::read(dest.path().join("d/inner/y.txt")).unwrap(),
            b"y"
        );
        // copy, not move: the source survives.
        assert!(src.path().join("a.txt").exists());

        let err = copy_inner(
            &reg,
            vec![s(src.path().join("a.txt"))],
            s(dest.path().to_path_buf()),
            None,
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn delete_removes_file_then_dir_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let reg = reg_for(dir.path());
        let f = dir.path().join("x.txt");
        std::fs::write(&f, b"x").unwrap();
        delete_inner(&reg, s(f.clone()), None).expect("delete file");
        assert!(!f.exists());

        let sub = dir.path().join("sub");
        std::fs::create_dir_all(sub.join("inner")).unwrap();
        std::fs::write(sub.join("inner/y.txt"), b"y").unwrap();
        delete_inner(&reg, s(sub.clone()), None).expect("delete dir");
        assert!(!sub.exists());

        let err = delete_inner(&reg, s(dir.path().join("missing")), None).unwrap_err();
        assert!(!err.is_empty());
    }

    // Deleting a symlink that points at a directory must remove only the link,
    // never recurse through it and wipe the target's contents.
    #[cfg(unix)]
    #[test]
    fn delete_does_not_follow_symlink_into_target() {
        let dir = tempfile::tempdir().unwrap();
        let reg = reg_for(dir.path());
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("keep.txt"), b"keep").unwrap();

        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        delete_inner(&reg, s(link.clone()), None).expect("delete symlink");
        assert!(!link.exists(), "symlink itself should be gone");
        assert!(real.is_dir(), "target dir must survive");
        assert_eq!(std::fs::read(real.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn require_authorized_rejects_paths_outside_roots() {
        let inside = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let reg = reg_for(inside.path());

        let inside_file = inside.path().join("ok.txt");
        std::fs::write(&inside_file, b"x").unwrap();
        assert!(require_authorized(&reg, &inside_file).is_ok());

        let outside_file = outside.path().join("nope.txt");
        std::fs::write(&outside_file, b"x").unwrap();
        assert!(require_authorized(&reg, &outside_file).is_err());

        // A `..` traversal out of an authorized root must not pass on the raw
        // component form.
        let traversal = inside.path().join("..").join("escape.txt");
        assert!(require_authorized(&reg, &traversal).is_err());
    }

    #[test]
    fn copy_refuses_destination_outside_workspace() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("a.txt"), b"payload").unwrap();
        // No root authorized: the destination is refused before any write.
        let reg = WorkspaceRegistry::default();
        let err = copy_inner(
            &reg,
            vec![s(src.path().join("a.txt"))],
            s(dest.path().to_path_buf()),
            None,
        )
        .unwrap_err();
        assert!(
            err.contains("outside the authorized workspace"),
            "got: {err}"
        );
        assert!(!dest.path().join("a.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_skips_symlinks_and_nested_secret_dirs() {
        use std::os::unix::fs::symlink;
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let secret = tempfile::tempdir().unwrap();
        let reg = reg_for(dest.path());

        std::fs::write(secret.path().join("id_rsa"), b"secret").unwrap();
        std::fs::create_dir_all(src.path().join("tree/.ssh")).unwrap();
        std::fs::write(src.path().join("tree/.ssh/id_rsa"), b"secret").unwrap();
        std::fs::write(src.path().join("tree/keep.txt"), b"keep").unwrap();
        symlink(&secret.path().join("id_rsa"), src.path().join("tree/link")).unwrap();

        copy_inner(
            &reg,
            vec![s(src.path().join("tree"))],
            s(dest.path().to_path_buf()),
            None,
        )
        .unwrap();

        let out = dest.path().join("tree");
        assert_eq!(std::fs::read(out.join("keep.txt")).unwrap(), b"keep");
        assert!(!out.join("link").exists());
        assert!(!out.join(".ssh").exists());
    }
}
