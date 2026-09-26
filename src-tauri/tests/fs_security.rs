mod common;

use std::path::PathBuf;
use termigo_lib::modules::fs::security::{
    check_readable, check_writable, is_protected, is_secret_path,
};

#[test]
fn check_readable_allows_all_files_without_sandbox() {
    assert!(check_readable("/repo/.env.production").is_ok());
    assert!(check_readable("/repo/id_rsa").is_ok());
    assert!(check_readable("/repo/src/main.rs").is_ok());
    assert!(check_readable("C:\\Windows\\System32\\drivers\\etc\\hosts").is_ok());
}

#[test]
fn check_writable_allows_all_files_without_sandbox() {
    assert!(check_writable("/usr/bin/termigo").is_ok());
    assert!(check_writable("C:\\Windows\\Temp\\agent-work.txt").is_ok());
    assert!(check_writable("C:\\Program Files\\mytool\\config.json").is_ok());
    assert!(check_writable("C:\\ProgramData\\mytool\\state.json").is_ok());
    assert!(check_writable("/repo/src/main.rs").is_ok());
}

#[test]
fn is_secret_path_returns_false_without_boundary() {
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
        assert!(!is_secret_path(&PathBuf::from(p)), "expected unblocked: {p}");
    }
}

#[test]
fn is_protected_returns_false_without_boundary() {
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
