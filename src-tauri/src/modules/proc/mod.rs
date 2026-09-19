#[cfg(windows)]
pub mod job;

use std::io;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[cfg(windows)]
pub fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
#[inline]
pub fn hide_console(_cmd: &mut Command) {}

/// Run a command to completion, but never wait longer than `timeout`.
///
/// A probe that shells out to `wsl.exe` can wedge indefinitely (a distro that
/// is booting, an install that is mid-upgrade), and a caller that blocks on
/// `output()` forever is how the UI ended up hanging. The child is spawned with
/// its pipes captured on a helper thread (so a full pipe can't deadlock the
/// wait); on timeout the process tree is killed and `TimedOut` is returned.
pub fn output_with_timeout(mut cmd: Command, timeout: Duration) -> io::Result<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let child = cmd.spawn()?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(res) => res,
        Err(_) => {
            kill_tree(pid);
            Err(io::Error::new(io::ErrorKind::TimedOut, "command timed out"))
        }
    }
}

#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let mut k = Command::new("taskkill");
    k.args(["/PID", &pid.to_string(), "/T", "/F"]);
    hide_console(&mut k);
    let _ = k.output();
}

/// Kill a process and its descendants on Unix.
 ///
 /// A bare `kill -9 <pid>` leaves backgrounded grandchildren alive - and a
 /// grandchild holding a stdout pipe keeps the drain threads in
 /// `run_blocking` blocked on `read()` forever, so the join after a timeout
 /// never returns. Recurse through `pgrep -P` (present on Linux, macOS and
 /// WSL) depth-first so grandchildren die before their parents reparent them
 /// to init; without `pgrep` this degrades to the single kill it replaces.
#[cfg(not(windows))]
pub fn kill_tree(pid: u32) {
    kill_tree_recursive(pid, 0);
}

#[cfg(not(windows))]
fn kill_tree_recursive(pid: u32, depth: u8) {
    if depth > 8 {
        return;
    }
    if let Ok(out) = Command::new("pgrep").arg("-P").arg(pid.to_string()).output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Ok(child) = line.trim().parse::<u32>() {
                    kill_tree_recursive(child, depth + 1);
                }
            }
        }
    }
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
}
