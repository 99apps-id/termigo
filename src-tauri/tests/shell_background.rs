use std::time::{Duration, Instant};

use termigo_lib::modules::shell::background;
use termigo_lib::modules::workspace::WorkspaceEnv;
use termigo_lib::modules::workspace::WorkspaceRegistry;

fn wait_until(deadline: Duration, mut pred: impl FnMut() -> bool) {
    let effective_deadline = if cfg!(windows) {
        deadline.max(Duration::from_secs(15))
    } else {
        deadline
    };
    let start = Instant::now();
    while start.elapsed() < effective_deadline {
        if pred() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("condition not met within {effective_deadline:?}");
}

#[test]
fn spawn_empty_command_errors() {
    assert!(background::spawn(
        "   ".into(),
        None,
        WorkspaceEnv::Local,
        None,
        &WorkspaceRegistry::default(),
    )
    .is_err());
}

#[test]
fn spawn_invalid_cwd_errors() {
    assert!(background::spawn(
        "true".into(),
        Some("/no/such/dir".into()),
        WorkspaceEnv::Local,
        None,
        &WorkspaceRegistry::default(),
    )
    .is_err());
}

#[test]
fn spawn_captures_stdout_and_exits_zero() {
    let command = if cfg!(windows) {
        "Write-Output hello"
    } else {
        "printf 'hello\\n'"
    };
    let proc = background::spawn(
        command.into(),
        None,
        WorkspaceEnv::Local,
        None,
        &WorkspaceRegistry::default(),
    )
    .expect("spawn");

    wait_until(Duration::from_secs(5), || proc.read_logs(0).exited);

    let first = proc.read_logs(0);
    #[cfg(windows)]
    assert!(first.bytes == "hello\r\n" || first.bytes == "hello\n");
    #[cfg(not(windows))]
    assert_eq!(first.bytes, "hello\n");
    assert!(first.exited);
    assert_eq!(first.exit_code, Some(0));
}

#[test]
fn spawn_captures_nonzero_exit() {
    let command = if cfg!(windows) {
        "cmd /c exit 1"
    } else {
        "false"
    };
    let proc = background::spawn(
        command.into(),
        None,
        WorkspaceEnv::Local,
        None,
        &WorkspaceRegistry::default(),
    )
    .expect("spawn");

    wait_until(Duration::from_secs(5), || proc.read_logs(0).exited);

    let first = proc.read_logs(0);
    assert!(first.bytes.is_empty());
    assert!(first.exited);
    assert_eq!(first.exit_code, Some(1));
}

/// A long-lived command that also produces output immediately.
///
/// `tail -f` on a prepared file does both: it prints the file's current content
/// and then stays alive. The tests here used `sleep`, which is not on the
/// command allowlist, and `printf a; printf b`, which the metacharacter guard
/// refuses - both rules landed after these tests were written.
#[cfg(unix)]
fn long_lived_command() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("lines.txt");
    std::fs::write(&file, "one\n").expect("write");
    // Forward slashes everywhere: the path is passed through to a shell, and a
    // backslash is an escape there.
    let path = file.to_string_lossy().replace('\\', "/");
    (dir, format!("tail -f {path}"))
}

// Unix only: a long-lived child that must be reaped, and `tail -f` semantics.
// On Windows the lingering child holds the test harness's output pipe, so the
// run hangs rather than failing.
#[cfg(unix)]
#[test]
fn kill_terminates_a_running_process() {
    let (_dir, command) = long_lived_command();
    let proc = background::spawn(
        command,
        None,
        WorkspaceEnv::Local,
        None,
        &WorkspaceRegistry::default(),
    )
    .expect("spawn");

    // The file's content should have landed before the kill.
    wait_until(Duration::from_secs(5), || {
        let logs = proc.read_logs(0);
        logs.bytes.contains("one")
    });

    proc.kill();

    let first = proc.read_logs(0);
    assert!(
        first.bytes.contains("one"),
        "expected partial output before kill, got: {}",
        first.bytes
    );
    // `exited` is not set by `kill` itself: the waiter thread sets it once it has
    // reaped the child, so asserting it on the very next line reads a flag that
    // is still false and the test fails on timing rather than on behaviour. This
    // is what the app does too - it polls `read_logs` rather than expecting the
    // signal to have been reaped synchronously. The assertion still proves the
    // kill took effect; `wait_until` panics with the deadline if it did not.
    wait_until(Duration::from_secs(5), || proc.read_logs(0).exited);
    assert!(proc.read_logs(0).exited, "process did not exit after kill");
}

#[cfg(unix)]
#[test]
fn read_logs_advances_offset() {
    let (_dir, command) = long_lived_command();
    let proc = background::spawn(
        command,
        None,
        WorkspaceEnv::Local,
        None,
        &WorkspaceRegistry::default(),
    )
    .expect("spawn");

    wait_until(Duration::from_secs(5), || {
        proc.read_logs(0).next_offset > 0
    });

    let first = proc.read_logs(0);
    assert!(first.next_offset > 0);

    let next = proc.read_logs(first.next_offset);
    assert!(
        next.bytes.is_empty(),
        "consumed offset must return no bytes"
    );
    assert_eq!(next.next_offset, first.next_offset);
}

#[test]
fn info_reflects_command_and_exit() {
    let proc = background::spawn(
        "true".into(),
        None,
        WorkspaceEnv::Local,
        None,
        &WorkspaceRegistry::default(),
    )
    .expect("spawn");

    wait_until(Duration::from_secs(5), || proc.read_logs(0).exited);

    let info = proc.info(1);
    assert!(info.exit_code.is_some());
}

#[test]
fn spawn_writes_full_log_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = WorkspaceRegistry::default();
    let _ = registry.authorize(dir.path());
    let log_path = dir.path().join("scan.log").to_string_lossy().into_owned();
    let command = if cfg!(windows) {
        "Write-Output line1; Write-Output line2"
    } else {
        "printf 'line1\\nline2\\n'"
    };
    let proc = background::spawn(
        command.into(),
        None,
        WorkspaceEnv::Local,
        Some(log_path.clone()),
        &registry,
    )
    .expect("spawn");

    wait_until(Duration::from_secs(5), || proc.read_logs(0).exited);

    let written = std::fs::read(log_path).expect("log file exists");
    #[cfg(windows)]
    assert!(written == b"line1\r\nline2\r\n" || written == b"line1\nline2\n");
    #[cfg(not(windows))]
    assert_eq!(written, b"line1\nline2\n");
}
