#![cfg(unix)]

use std::time::{Duration, Instant};

use termigo_lib::modules::shell::background;
use termigo_lib::modules::workspace::WorkspaceEnv;

fn wait_until<F: Fn() -> bool>(timeout: Duration, check: F) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    check()
}

#[test]
fn spawn_empty_command_errors() {
    assert!(background::spawn("   ".into(), None, WorkspaceEnv::Local, None).is_err());
}

#[test]
fn spawn_invalid_cwd_errors() {
    let err = background::spawn(
        "true".into(),
        Some("/no/such/dir".into()),
        WorkspaceEnv::Local,
        None,
    );
    assert!(err.is_err());
}

#[test]
fn spawn_captures_stdout_and_exits_zero() {
    let proc = background::spawn(
        "printf 'hello\\n'".into(),
        None,
        WorkspaceEnv::Local,
        None,
    )
    .expect("spawn");

    assert!(wait_until(Duration::from_secs(5), || {
        proc.read_logs(0).exited
    }));

    let logs = proc.read_logs(0);
    assert!(logs.bytes.contains("hello"));
    assert!(logs.exited);
    assert_eq!(logs.exit_code, Some(0));
}

#[test]
fn spawn_captures_nonzero_exit() {
    let proc = background::spawn("exit 42".into(), None, WorkspaceEnv::Local, None).expect("spawn");

    assert!(wait_until(Duration::from_secs(5), || {
        proc.read_logs(0).exited
    }));
    assert_eq!(proc.read_logs(0).exit_code, Some(42));
}

#[test]
fn kill_terminates_a_running_process() {
    let proc =
        background::spawn("sleep 30".into(), None, WorkspaceEnv::Local, None).expect("spawn");

    proc.kill();

    assert!(
        wait_until(Duration::from_secs(5), || { proc.read_logs(0).exited }),
        "killed process must reach exited state",
    );
}

#[test]
fn read_logs_advances_offset() {
    let proc = background::spawn(
        "printf 'one\\n'; printf 'two\\n'".into(),
        None,
        WorkspaceEnv::Local,
        None,
    )
    .expect("spawn");

    assert!(wait_until(Duration::from_secs(5), || {
        proc.read_logs(0).exited
    }));

    let first = proc.read_logs(0);
    assert!(first.next_offset > 0);

    let next = proc.read_logs(first.next_offset);
    assert!(next.bytes.is_empty(), "consumed offset must return no bytes");
    assert_eq!(next.next_offset, first.next_offset);
}

#[test]
fn info_reflects_command_and_exit() {
    let proc = background::spawn("true".into(), None, WorkspaceEnv::Local, None).expect("spawn");
    let info_running = proc.info(7);
    assert_eq!(info_running.handle, 7);
    assert_eq!(info_running.command, "true");

    assert!(wait_until(Duration::from_secs(5), || {
        proc.read_logs(0).exited
    }));
    let info_done = proc.info(7);
    assert!(info_done.exited);
    assert_eq!(info_done.exit_code, Some(0));
    assert_eq!(info_done.log_path, None);
}

#[test]
fn spawn_writes_full_log_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("scan.log").to_string_lossy().into_owned();
    let proc = background::spawn(
        "printf 'line1\\n'; printf 'line2\\n'".into(),
        None,
        WorkspaceEnv::Local,
        Some(log_path.clone()),
    )
    .expect("spawn");

    assert!(wait_until(Duration::from_secs(5), || {
        proc.read_logs(0).exited
    }));

    let content = std::fs::read_to_string(&log_path).expect("read log");
    assert!(content.contains("line1"));
    assert!(content.contains("line2"));
    // The full log is also surfaced on the process and its log reads.
    assert_eq!(proc.info(1).log_path.as_deref(), Some(log_path.as_str()));
    assert_eq!(proc.read_logs(0).log_path.as_deref(), Some(log_path.as_str()));
    // The in-memory ring still carries the tail for progress polling.
    assert!(proc.read_logs(0).bytes.contains("line1"));
}
