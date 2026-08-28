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
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "command timed out",
            ))
        }
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let mut k = Command::new("taskkill");
    k.args(["/PID", &pid.to_string(), "/T", "/F"]);
    hide_console(&mut k);
    let _ = k.output();
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let mut k = Command::new("kill");
    k.args(["-9", &pid.to_string()]);
    let _ = k.output();
}
