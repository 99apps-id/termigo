//! Source-level guard: a command that takes a filesystem path must consult the
//! workspace authorization registry.
//!
//! The F-14 audit found 20 of 21 `fs::*` commands resolved a path and applied
//! the secret deny-list but never checked `WorkspaceRegistry::is_authorized`.
//! Fixing those functions does not stop the next command from being written
//! without the check - the invariant lived only in a doc comment and in a
//! reviewer's memory. This test reads the registered command list out of
//! `lib.rs` and asserts the rule mechanically, so forgetting it fails CI
//! instead of shipping.
//!
//! The rule is checked per SOURCE FILE, not per function. Several modules are
//! written as a thin command shell over an authorizing helper (`git::commands`
//! delegates to `git::operations`, `fs::tree` to its `*_blocking` walkers), so
//! a per-function check reports those as violations and would be turned off the
//! first time it was wrong. Per-file keeps the signal: a module with no
//! authorization call anywhere is exactly the shape of the `sql.rs` miss.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Calls that satisfy the rule: any of these proves the module consulted the
/// allow-side boundary (or handed the decision to a helper that does).
const AUTHORIZATION_CALLS: &[&str] = &[
    "require_authorized",
    "authorize_spawn_cwd",
    "authorize_user_spawn_cwd",
    "user_spawn_cwd_or_home",
    "is_authorized",
];

/// Calls that prove the deny-list half was consulted. A module that only reads
/// local files (no workspace semantics) may satisfy the rule this way.
const DENY_LIST_CALLS: &[&str] = &["validate_read", "guard_read", "check_readable"];

/// Parameters that mean the command touches a filesystem location. `repo:` is
/// deliberately absent: in this codebase it is an `owner/repo` slug, not a path
/// (`repo_root:` is the path form).
const PATH_PARAMS: &[&str] = &[
    "path:",
    "paths:",
    "local_path:",
    "cwd:",
    "connection:",
    "dir:",
    "dirs:",
    "root:",
    "repo_root:",
    "files:",
    "rel_path:",
    "zip_path:",
];

/// Modules whose path-taking commands delegate to an authorizing helper in
/// another file, with the reason. Module-level because the delegation is a
/// property of how the module is written, not of one command.
const MODULES_DELEGATING_AUTHORIZATION: &[(&str, &str)] = &[(
    "git::commands",
    "every repo path is handed to `git::operations`, which consults the \
     registry (the commands themselves only forward it)",
)];

/// Path-taking commands whose implementation legitimately needs neither check,
/// each with the reason. Every entry is a deliberate decision, which is why it
/// has to be written down here rather than inferred.
const ALLOWED_WITHOUT_AUTHORIZATION: &[(&str, &str)] = &[
    (
        "fs_watch_remove",
        "releases a watch subscription and touches no data; the directory it \
         names was authorized when the watch was added",
    ),
    (
        "ext_read_asset",
        "confined to the extension's own sandbox directory by resolve_asset, \
         which refuses `..` and absolute rel paths",
    ),
    (
        "ext_read_asset_bytes",
        "same as ext_read_asset",
    ),
    (
        "workspace_authorize",
        "this IS the registry's add operation",
    ),
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `module::command` entries inside the `invoke_handler(generate_handler![...])`
/// block, as `(module, command)`.
///
/// The registered path can be `module::command` or `module::submodule::command`
/// (`fs::tree::list_subdirs`), so the split is on the LAST `::`: everything
/// before it is the module path, the last segment is the command.
fn registered_commands(lib_rs: &str) -> BTreeSet<(String, String)> {
    let start = lib_rs
        .find("invoke_handler")
        .expect("lib.rs declares an invoke_handler");
    let rest = &lib_rs[start..];
    let end = rest
        .find("])")
        .expect("the invoke_handler block is closed");
    let block = &rest[..end];

    let mut out = BTreeSet::new();
    for raw in block.lines() {
        let line = raw.trim().trim_end_matches(',');
        // Only `module::command` lines; the `.manage(...)` setup above and any
        // nested calls are skipped by requiring identifiers on both sides.
        let Some((module, command)) = line.rsplit_once("::") else {
            continue;
        };
        let is_ident = |s: &str| {
            !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        };
        let is_module_path = !module.is_empty()
            && module.split("::").all(is_ident);
        if is_module_path && is_ident(command) {
            out.insert((module.to_string(), command.to_string()));
        }
    }
    out
}

/// Every `.rs` file under `src/`, as `(path, contents)`.
fn rust_sources(root: &Path) -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&root.join("src"), &mut files);
    files
        .into_iter()
        .filter_map(|p| std::fs::read_to_string(&p).ok().map(|c| (p, c)))
        .collect()
}

/// The signature of `name`, cut before its body. Boundaries are the `->` or the
/// opening brace: a `path:` inside a body is a local variable, not a parameter,
/// and a `format!("{}")` in a body would defeat brace counting.
fn signature_of<'a>(source: &'a str, name: &str) -> Option<&'a str> {
    for prefix in ["pub fn ", "pub async fn "] {
        let needle = format!("{prefix}{name}");
        let Some(start) = source.find(&needle) else {
            continue;
        };
        // Require a boundary after the name so `fs_read_dir` does not match
        // `fs_read_dir_blocking`, whose body has no authorization.
        let after = source[start + needle.len()..].chars().next();
        if after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let tail = &source[start..];
        let end = tail
            .find("->")
            .or_else(|| tail.find('{'))
            .unwrap_or(tail.len());
        return Some(&tail[..end]);
    }
    None
}

fn takes_a_path(source: &str, command: &str) -> bool {
    let Some(signature) = signature_of(source, command) else {
        return false;
    };
    PATH_PARAMS.iter().any(|p| signature.contains(p))
}

fn module_checks_authorization(source: &str) -> bool {
    AUTHORIZATION_CALLS
        .iter()
        .chain(DENY_LIST_CALLS.iter())
        .any(|c| source.contains(c))
}

fn allowed_without_authorization(command: &str) -> bool {
    ALLOWED_WITHOUT_AUTHORIZATION
        .iter()
        .any(|(name, _)| *name == command)
}

fn module_delegates_authorization(module: &str) -> bool {
    MODULES_DELEGATING_AUTHORIZATION
        .iter()
        .any(|(name, _)| *name == module)
}

#[test]
fn every_path_taking_command_consults_the_workspace_registry() {
    let root = manifest_dir();
    let lib_rs = std::fs::read_to_string(root.join("src/lib.rs"))
        .expect("read src-tauri/src/lib.rs");
    let commands = registered_commands(&lib_rs);
    assert!(
        commands.len() > 80,
        "expected the full command catalogue, parsed {} entries - the parser \
         or the invoke_handler block changed shape",
        commands.len()
    );

    let sources = rust_sources(&root);

    let mut violations = Vec::new();
    let mut checked = BTreeSet::new();

    for (module, command) in &commands {
        // Several modules share the `fs::`/`shell::` prefix across files, so
        // find the declaring file by its declaration rather than by guessing
        // the filename from the module path.
        let Some((path, source)) = sources.iter().find_map(|(p, s)| {
            (s.contains(&format!("pub fn {command}"))
                || s.contains(&format!("pub async fn {command}")))
            .then_some((p, s))
        }) else {
            panic!("registered command `{module}::{command}` has no declaration");
        };

        if !takes_a_path(source, command) {
            continue;
        }
        checked.insert(command.clone());
        if module_checks_authorization(source)
            || allowed_without_authorization(command)
            || module_delegates_authorization(module)
        {
            continue;
        }
        violations.push(format!(
            "{}: `{}` takes a path but the module calls none of {:?}",
            path.strip_prefix(&root).unwrap_or(path).display(),
            command,
            AUTHORIZATION_CALLS
        ));
    }

    assert!(
        checked.len() > 25,
        "only {} path-taking commands were found; the parameter heuristic \
         probably stopped matching",
        checked.len()
    );

    assert!(
        violations.is_empty(),
        "path-taking commands must consult the workspace registry:\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn the_allowlist_has_no_stale_entries() {
    let root = manifest_dir();
    let lib_rs = std::fs::read_to_string(root.join("src/lib.rs")).expect("read lib.rs");
    let commands = registered_commands(&lib_rs);
    let names: BTreeSet<&str> = commands.iter().map(|(_, c)| c.as_str()).collect();

    for (name, _) in ALLOWED_WITHOUT_AUTHORIZATION {
        assert!(
            names.contains(*name),
            "`{name}` is allow-listed but no longer registered; remove it"
        );
    }
}
