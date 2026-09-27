mod common;

use std::path::PathBuf;
use termigo_lib::modules::fs::security::{
    check_readable, check_writable, is_protected, is_secret_path,
};

/// Reads stay open by policy: an agent asked to debug config legitimately reads
/// files it may not write, and a read wall inside the process is bypassable
/// through a terminal anyway. Writes are a different question, and that wall sits
/// on the files deciding what runs later plus the directories holding credentials
/// or git internals.
#[test]
fn check_readable_allows_files_it_may_not_write() {
    for path in [
        "/repo/.env.production",
        "/repo/id_rsa",
        "/repo/src/main.rs",
        "/repo/.termigo/hooks.json",
        "/home/user/.ssh/id_rsa",
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
    ] {
        assert!(check_readable(path).is_ok(), "refused: {path}");
    }
}

#[test]
fn check_writable_allows_ordinary_workspace_work() {
    assert!(check_writable("/usr/bin/termigo").is_ok());
    assert!(check_writable("C:\\Windows\\Temp\\agent-work.txt").is_ok());
    assert!(check_writable("C:\\Program Files\\mytool\\config.json").is_ok());
    assert!(check_writable("C:\\ProgramData\\mytool\\state.json").is_ok());
    assert!(check_writable("/repo/src/main.rs").is_ok());
    assert!(check_writable("/repo/.env").is_ok());
}

#[test]
fn check_writable_refuses_execution_triggers_and_credentials() {
    for path in [
        "/repo/.termigo/hooks.json",
        r"C:\repo\.termigo\hooks.json",
        "/repo/.termigo/mcp.json",
        "/repo/.claude/settings.json",
        "/repo/.claude/settings.local.json",
        "/repo/.codex/config.toml",
        "/repo/.gemini/settings.json",
        "/repo/.git/hooks/pre-commit",
        "/repo/.git/config",
        "/home/user/.ssh/authorized_keys",
        "/home/user/.aws/credentials",
    ] {
        assert!(check_writable(path).is_err(), "allowed: {path}");
    }
}

/// The read-side predicates stay false by policy, which is what lets `tree`,
/// `grep`, and `search` walk a workspace without pruning it. They are not the
/// write wall: `check_writable` refuses the same paths these report as open.
#[test]
fn read_side_secret_predicate_stays_open() {
    let cases = [
        "/home/user/.ssh/id_rsa",
        "/home/user/.ssh/id_ed25519.pub",
        "/home/user/.aws/credentials",
        "/home/user/.env",
        "/home/user/.env.local",
        "/home/user/secrets.json",
        "/home/user/.pem",
        "/home/user/.netrc",
        "/repo/.env.example",
        "/repo/src/main.rs",
    ];
    for p in &cases {
        assert!(
            !is_secret_path(&PathBuf::from(p)),
            "expected unblocked: {p}"
        );
    }
}

#[test]
fn read_side_protected_predicate_stays_open() {
    assert!(!is_protected(&PathBuf::from("/home/user/.ssh/config")));
    assert!(!is_protected(&PathBuf::from("/repo/.git/config")));
    assert!(!is_protected(&PathBuf::from("/etc")));
    assert!(!is_protected(&PathBuf::from("/repo/src")));
}

#[test]
fn workspace_registry_tracks_authorized_workspace_roots() {
    use termigo_lib::modules::workspace::WorkspaceRegistry;

    let registry = WorkspaceRegistry::default();
    let tmp = common::FsFixture::new();
    registry.authorize(&tmp.root).unwrap();

    // Path inside workspace -> ok
    assert!(registry.is_authorized(&tmp.root.join("src/main.rs")));

    // In the no-boundary architecture every path is authorized.
    // The registry still tracks roots (for asset-scope replication) but
    // is_authorized returns true for any path.
    assert!(registry.is_authorized(&PathBuf::from("/etc/passwd")));
    assert!(registry.is_authorized(&PathBuf::from("/home/user/.ssh/id_rsa")));
}
