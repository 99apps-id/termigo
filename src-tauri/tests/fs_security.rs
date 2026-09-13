mod common;

use std::path::PathBuf;
use termigo_lib::modules::fs::security::{
    check_readable, check_writable, is_protected, is_secret_path,
};

// ---------------------------------------------------------------------------
// check_readable / check_writable / is_secret_path / is_protected
// ---------------------------------------------------------------------------

#[test]
fn check_readable_blocks_secret_basenames() {
    let err = check_readable("/repo/.env.production").unwrap_err();
    assert!(err.contains("sensitive-file pattern"));

    let err = check_readable("/repo/id_rsa").unwrap_err();
    assert!(err.contains("sensitive-file pattern"));
}

#[test]
#[cfg(unix)]
fn check_readable_blocks_protected_dirs_on_unix() {
    let err = check_readable("/home/.ssh/known_hosts").unwrap_err();
    assert!(err.contains("protected directory"));
}

#[test]
#[cfg(windows)]
fn check_readable_blocks_protected_dirs_on_windows() {
    let err = check_readable("C:\\Windows\\System32\\drivers\\etc\\hosts").unwrap_err();
    assert!(err.contains("protected directory"));
}

#[test]
fn check_readable_blocks_control_bytes() {
    let err = check_readable("/repo/\x00evil").unwrap_err();
    assert!(err.contains("control bytes"));
}

#[test]
fn check_readable_allows_normal_files() {
    assert!(check_readable("/repo/src/main.rs").is_ok());
}

#[test]
#[cfg(unix)]
fn check_writable_blocks_system_prefixes_on_unix() {
    let err = check_writable("/etc/passwd").unwrap_err();
    assert!(err.contains("writes under"));
}

#[test]
#[cfg(windows)]
fn check_writable_blocks_system_prefixes_on_windows() {
    let err = check_writable("C:\\Windows\\System32\\evil.exe").unwrap_err();
    assert!(err.contains("writes under"));
}

#[test]
fn check_writable_allows_workspace_files() {
    assert!(check_writable("/repo/src/main.rs").is_ok());
}

#[test]
fn is_secret_path_blocks_common_secrets() {
    let cases = [
        "/home/user/.ssh/id_rsa",
        "/home/user/.ssh/id_ed25519.pub",
        "/home/user/.aws/credentials",
        "/home/user/.env",
        "/home/user/.env.local",
        "/home/user/secrets.json",
        "/home/user/.pem",
        "/home/user/.netrc",
        "/home/user/credentials.txt",
        "/home/user/.gnupg/secring.gpg",
    ];
    for p in &cases {
        assert!(is_secret_path(&PathBuf::from(p)), "expected blocked: {p}");
    }
}

#[test]
fn is_secret_path_allows_safe_env_templates() {
    let cases = [
        "/repo/.env.example",
        "/repo/.env.sample",
        "/repo/.env.template",
        "/repo/.env.dist",
    ];
    for p in &cases {
        assert!(!is_secret_path(&PathBuf::from(p)), "expected allowed: {p}");
    }
}

#[test]
fn is_secret_path_allows_ordinary_files() {
    assert!(!is_secret_path(&PathBuf::from("/repo/src/main.rs")));
    assert!(!is_secret_path(&PathBuf::from("/repo/README.md")));
}

#[test]
#[cfg(unix)]
fn is_protected_blocks_ssh_and_git_on_unix() {
    assert!(is_protected(&PathBuf::from("/home/user/.ssh/config")));
    assert!(is_protected(&PathBuf::from("/repo/.git/config")));
    assert!(is_protected(&PathBuf::from("/home/user/.gnupg")));
}

#[test]
#[cfg(windows)]
fn is_protected_blocks_windows_credential_dirs() {
    // /appdata/... paths are in PROTECTED_DIRS after comparison_form strips the
    // drive letter. /windows/ and /program files/ are only in WRITE_DENY_PREFIXES.
    assert!(is_protected(&PathBuf::from(
        "C:\\Users\\test\\AppData\\Roaming\\Microsoft\\Credentials\\test"
    )));
    assert!(is_protected(&PathBuf::from(
        "C:\\Users\\test\\AppData\\Local\\Microsoft\\Credentials\\test"
    )));
    assert!(is_protected(&PathBuf::from(
        "C:\\Users\\test\\AppData\\Roaming\\gcloud\\credentials.db"
    )));
}

#[test]
fn is_protected_allows_regular_paths() {
    assert!(!is_protected(&PathBuf::from("/repo/src")));
    assert!(!is_protected(&PathBuf::from("/home/user/projects")));
}

// ---------------------------------------------------------------------------
// guard_read: symlink-into-protected-dir
// ---------------------------------------------------------------------------

#[test]
#[cfg(unix)]
fn guard_read_blocks_symlink_into_ssh() {
    let tmp = common::FsFixture::new();
    // Create a real secret dir and a symlink to it from outside.
    let secret = tmp.root.join("real_secret");
    std::fs::create_dir_all(&secret).unwrap();
    std::fs::write(secret.join("id_rsa"), "key").unwrap();

    let link = tmp.root.join("link_to_secret");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    let linked_path = link.join("id_rsa");

    let result = guard_read(&linked_path);
    assert!(
        result.is_err(),
        "symlink into .ssh-like dir must be refused"
    );
}

// ---------------------------------------------------------------------------
// Workspace authorization invariant
// ---------------------------------------------------------------------------

#[test]
fn fs_commands_reject_paths_outside_authorized_workspace() {
    use termigo_lib::modules::workspace::WorkspaceRegistry;

    let registry = WorkspaceRegistry::default();
    // Use a temp dir that actually exists on this platform.
    let tmp = common::FsFixture::new();
    registry.authorize(&tmp.root).unwrap();

    // Path inside workspace -> ok
    assert!(registry.is_authorized(&tmp.root.join("src/main.rs")));

    // Path outside workspace -> rejected
    assert!(!registry.is_authorized(&PathBuf::from("/etc/passwd")));
    assert!(!registry.is_authorized(&PathBuf::from("/home/user/.ssh/id_rsa")));
}
