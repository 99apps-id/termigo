use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::modules::fs::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

// Quiet-gap before a batch flushes; MAX_WINDOW caps latency under a long stream.
const DEBOUNCE: Duration = Duration::from_millis(150);
const MAX_WINDOW: Duration = Duration::from_millis(1000);

// Matched on the final path component. Never watched even when expanded: large
// or generated trees where live updates cost more than they're worth.
const SKIP_DIRS: &[&str] = &[
    // VCS
    ".git",
    ".hg",
    ".svn",
    ".jj",
    // JS / web
    "node_modules",
    "bower_components",
    ".pnpm-store",
    ".yarn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".astro",
    ".vite",
    ".turbo",
    ".parcel-cache",
    ".angular",
    ".vercel",
    ".netlify",
    ".output",
    ".cache",
    // Rust
    "target",
    // Python
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".ipynb_checkpoints",
    ".eggs",
    // JVM / Gradle
    ".gradle",
    // .NET
    "obj",
    // Go / PHP
    "vendor",
    // Elixir
    "_build",
    "deps",
    // Dart / Flutter
    ".dart_tool",
    // Haskell
    "dist-newstyle",
    ".stack-work",
    // Swift / Zig
    ".build",
    "zig-cache",
    "zig-out",
    // CMake (CLion)
    "cmake-build-debug",
    "cmake-build-release",
    // IDE / coverage / infra
    ".idea",
    "coverage",
    ".nyc_output",
    ".terraform",
];

fn is_skipped(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| SKIP_DIRS.contains(&n))
}

#[derive(Default)]
pub struct FsWatchState {
    inner: Mutex<Option<WatchInner>>,
}

struct WatchInner {
    watcher: RecommendedWatcher,
    // Explorer (expanded dirs) and editor (dirs of open files) can request the
    // same dir; unwatch only when the last requester releases it.
    refcounts: HashMap<PathBuf, Watched>,
}

/// One watched directory: the spelling handed to the watcher, and how many
/// requesters hold it.
struct Watched {
    path: PathBuf,
    refs: usize,
}

/// The bookkeeping key for a directory, so add and remove agree on one entry
/// however the path was spelled.
///
/// They did not, and a directory that was renamed or deleted could never be
/// released: add stores the canonical spelling (`\\?\C:\proj\src` on Windows),
/// while remove falls back to the plain resolved one when `canonicalize` fails
/// on a path that no longer exists, and the two never matched. The entry stayed
/// in the map for the life of the process, and re-adding the same path
/// incremented the stale count instead of starting a fresh one, so the last
/// legitimate release only decremented it and the watch was never dropped.
fn watch_key(path: &Path) -> PathBuf {
    // `to_canon` is the single place that strips the Windows verbatim prefix and
    // normalizes separators.
    let canon = crate::modules::fs::to_canon(path);
    let trimmed = canon.trim_end_matches('/');
    let key = if trimmed.is_empty() {
        canon.as_str()
    } else {
        trimmed
    };
    #[cfg(windows)]
    {
        // Windows compares paths case-insensitively, so a key must too.
        PathBuf::from(key.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        // Case and separators are significant on Unix.
        PathBuf::from(key)
    }
}

#[derive(Clone, serde::Serialize)]
struct ChangedPayload {
    paths: Vec<String>,
}

fn ensure_started(state: &FsWatchState, app: &AppHandle) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let app = app.clone();
    std::thread::Builder::new()
        .name("termigo-fs-watch".into())
        .spawn(move || drain_loop(rx, app))
        .map_err(|e| e.to_string())?;

    *guard = Some(WatchInner {
        watcher,
        refcounts: HashMap::new(),
    });
    Ok(())
}

fn drain_loop(rx: mpsc::Receiver<notify::Result<Event>>, app: AppHandle) {
    loop {
        let first = match rx.recv() {
            Ok(ev) => ev,
            Err(_) => return,
        };

        let mut paths: HashSet<String> = HashSet::new();
        collect(&mut paths, first);

        let deadline = Instant::now() + MAX_WINDOW;
        loop {
            let timeout = DEBOUNCE.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(timeout) {
                Ok(ev) => collect(&mut paths, ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
        }

        if paths.is_empty() {
            continue;
        }
        let _ = app.emit(
            "fs:changed",
            ChangedPayload {
                paths: paths.into_iter().collect(),
            },
        );
    }
}

fn collect(set: &mut HashSet<String>, ev: notify::Result<Event>) {
    let Ok(ev) = ev else { return };
    if matches!(ev.kind, EventKind::Access(_)) {
        return;
    }
    for p in ev.paths {
        set.insert(to_canon(&p));
    }
}

fn add_paths(inner: &mut WatchInner, paths: Vec<PathBuf>) {
    for canonical in paths {
        let key = watch_key(&canonical);
        if let Some(entry) = inner.refcounts.get_mut(&key) {
            entry.refs += 1;
            continue;
        }
        match inner.watcher.watch(&canonical, RecursiveMode::NonRecursive) {
            Ok(()) => {
                inner.refcounts.insert(
                    key,
                    Watched {
                        path: canonical,
                        refs: 1,
                    },
                );
            }
            Err(e) => log::debug!("fs_watch add {} failed: {e}", canonical.display()),
        }
    }
}

fn remove_paths(inner: &mut WatchInner, paths: Vec<PathBuf>) {
    for path in paths {
        let key = watch_key(&path);
        let Some(refs) = inner.refcounts.get(&key).map(|entry| entry.refs) else {
            continue;
        };
        if refs > 1 {
            if let Some(entry) = inner.refcounts.get_mut(&key) {
                entry.refs -= 1;
            }
            continue;
        }
        if let Some(entry) = inner.refcounts.remove(&key) {
            let _ = inner.watcher.unwatch(&entry.path);
        }
    }
}

// Canonical keys keep add/remove symmetric regardless of how the path was spelled.
fn prepare_add(
    registry: &WorkspaceRegistry,
    workspace: &WorkspaceEnv,
    paths: Vec<String>,
) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter_map(|raw| {
            let resolved = resolve_path(&raw, workspace);
            let canonical = std::fs::canonicalize(&resolved).ok()?;
            if !canonical.is_dir() || is_skipped(&canonical) || !registry.is_authorized(&canonical)
            {
                return None;
            }
            Some(canonical)
        })
        .collect()
}

#[tauri::command]
pub fn fs_watch_add(
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
    state: State<'_, FsWatchState>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let prepared = prepare_add(&registry, &workspace, paths);
    if prepared.is_empty() {
        return Ok(());
    }
    ensure_started(&state, &app)?;
    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(inner) = guard.as_mut() {
        add_paths(inner, prepared);
    }
    Ok(())
}

#[tauri::command]
pub fn fs_watch_remove(
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    state: State<'_, FsWatchState>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    // A removed/renamed dir no longer canonicalizes; fall back so the refcount
    // entry is still released.
    let prepared: Vec<PathBuf> = paths
        .into_iter()
        .map(|raw| {
            let resolved = resolve_path(&raw, &workspace);
            std::fs::canonicalize(&resolved).unwrap_or(resolved)
        })
        .collect();
    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(inner) = guard.as_mut() {
        remove_paths(inner, prepared);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_filter_matches_basename() {
        assert!(is_skipped(Path::new("/a/b/node_modules")));
        assert!(is_skipped(Path::new("/x/target")));
        assert!(is_skipped(Path::new("/p/obj")));
        assert!(!is_skipped(Path::new("/a/src")));
        assert!(!is_skipped(Path::new("/a/node_modules/pkg")));
    }

    #[test]
    fn collect_ignores_access_and_dedups() {
        let mut set = HashSet::new();
        collect(
            &mut set,
            Ok(Event {
                kind: EventKind::Access(notify::event::AccessKind::Read),
                paths: vec![PathBuf::from("/a/x")],
                attrs: Default::default(),
            }),
        );
        assert!(set.is_empty());

        let modify = || {
            Ok(Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Any),
                paths: vec![PathBuf::from("/a/x")],
                attrs: Default::default(),
            })
        };
        collect(&mut set, modify());
        collect(&mut set, modify());
        assert_eq!(set.len(), 1);
    }

    /// The two spellings the add and remove paths actually produce have to land
    /// on one key, or the release is lost. On Windows add stores what
    /// `canonicalize` returned (`\\?\C:\...`, and case-preserved) while remove
    /// falls back to the plain resolved path when the directory is gone.
    #[test]
    fn watch_keys_agree_across_spellings() {
        assert_eq!(watch_key(Path::new("/a/b/")), watch_key(Path::new("/a/b")));
        #[cfg(windows)]
        {
            assert_eq!(
                watch_key(Path::new(r"\\?\C:\Proj\Src")),
                watch_key(Path::new("C:/proj/src"))
            );
            assert_eq!(
                watch_key(Path::new(r"C:\proj\src")),
                watch_key(Path::new("C:/proj/src"))
            );
        }
        #[cfg(not(windows))]
        {
            // Case is significant on Unix: the keys must stay distinct.
            assert_ne!(watch_key(Path::new("/a/B")), watch_key(Path::new("/a/b")));
        }
    }

    /// The regression itself: a directory released with a different spelling
    /// than it was added with must still be unwatched. Before the key existed,
    /// the entry outlived its release and the final consumer of a renamed
    /// directory could never drop the watch.
    #[test]
    fn a_released_directory_leaves_no_watch_behind() {
        let dir = tempfile::tempdir().expect("temp directory");
        let real = std::fs::canonicalize(dir.path()).expect("canonicalize");
        let mut inner = WatchInner {
            watcher: RecommendedWatcher::new(|_| {}, Config::default()).expect("watcher"),
            refcounts: HashMap::new(),
        };

        add_paths(&mut inner, vec![real.clone()]);
        assert_eq!(inner.refcounts.len(), 1, "the watch was not registered");

        let other_spelling = PathBuf::from(format!("{}/", real.display()));
        remove_paths(&mut inner, vec![other_spelling]);

        assert!(
            inner.refcounts.is_empty(),
            "the watch entry outlived its release"
        );
    }
}
