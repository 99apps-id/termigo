//! Long-lived interactive processes the agent can hold a conversation with.
//!
//! The rest of this module runs commands: send one, wait for it to finish, take
//! the output. That shape is why `bash_run` says never to start `vim`, `less`
//! or a debugger - an interactive tool never finishes, so the call just burns
//! its timeout. `background.rs` keeps a process alive but gives it no stdin,
//! because a daemon should not inherit one.
//!
//! A debugger is neither. `pdb`, `dlv`, `gdb` and a language REPL all work the
//! same way: write a line, read until the prompt comes back, write the next
//! one. That is what this provides, and it is the whole difference between
//! running a command and talking to one.
//!
//! Deliberately not the user's terminal. The agent gets its own process, so
//! nothing here can type into a shell that may be holding sudo or an SSH
//! session to production.

use std::io::{Read, Write};
use std::process::{ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use shared_child::SharedChild;

use super::ringbuffer::BoundedRingBuffer;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const RING_CAP: usize = 256 * 1024;
/// Polling step while waiting for a prompt. Short enough to feel immediate,
/// long enough that a slow debugger does not spin a core.
const POLL_MS: u64 = 25;
/// Live interactive processes allowed at once. Each holds a child, two reader
/// threads and its pipes, so this is a resource bound rather than a policy.
pub const MAX_LIVE: usize = 8;
pub const DEFAULT_WAIT_SECS: u64 = 30;
pub const MAX_WAIT_SECS: u64 = 600;

pub struct ReplProc {
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub child: Arc<SharedChild>,
    #[cfg(windows)]
    pub(crate) _job: Option<crate::modules::proc::job::ProcessJob>,
    /// Taken once at spawn and held for the life of the process.
    stdin: Mutex<Option<ChildStdin>>,
    pub buffer: Mutex<BoundedRingBuffer>,
    pub exited: AtomicBool,
    pub exit_code: AtomicI32,
    pub exit_unknown: AtomicBool,
}

#[derive(Serialize)]
pub struct ReplTurn {
    /// Everything the process wrote since the previous turn.
    pub output: String,
    /// Whether `until` was seen. False means the wait timed out.
    pub matched: bool,
    pub next_offset: u64,
    /// Bytes lost to the ring buffer cap, so a caller can say output was cut.
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct ReplInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

impl ReplProc {
    fn exit_code_opt(&self) -> Option<i32> {
        if !self.exited.load(Ordering::Acquire) {
            return None;
        }
        if self.exit_unknown.load(Ordering::Acquire) {
            return None;
        }
        Some(self.exit_code.load(Ordering::Acquire))
    }

    pub fn info(&self, handle: u32) -> ReplInfo {
        ReplInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited: self.exited.load(Ordering::Acquire),
            exit_code: self.exit_code_opt(),
        }
    }

    /// Write one line to the process, appending the newline it is waiting for.
    ///
    /// The newline is added here rather than trusted from the caller: a line
    /// that arrives without one leaves the debugger waiting for input that was
    /// already sent, which reads as a hang.
    pub fn send_line(&self, line: &str) -> Result<(), String> {
        if self.exited.load(Ordering::Acquire) {
            return Err("process has exited".into());
        }
        if let Ok(Some(_)) = self.child.try_wait() {
            self.exited.store(true, Ordering::Release);
            return Err("process has exited".into());
        }
        let mut guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.as_mut().ok_or("stdin is closed")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|e| format!("write to process failed: {e}"))
    }

    /// Close stdin, which is how a REPL is asked to exit politely.
    pub fn close_stdin(&self) {
        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Read from `since` until `until` appears, the process exits, or time runs
    /// out.
    ///
    /// Matching is a plain substring on the accumulated output, not a regex:
    /// prompts are literals (`(Pdb) `, `(dlv) `, `>>> `), and a pattern
    /// language here would mean escaping rules and a way to hang on a bad one.
    ///
    /// A timeout is not an error. A debugger that is still running the program
    /// has simply not prompted yet, and the caller may want to wait again or
    /// interrupt - so the output so far is returned either way, with `matched`
    /// saying which happened.
    pub fn wait_for(&self, since: u64, until: Option<&str>, timeout: Duration) -> ReplTurn {
        let deadline = Instant::now() + timeout;
        let mut collected: Vec<u8> = Vec::new();
        let mut offset = since;
        let mut dropped_total = 0u64;

        loop {
            let (bytes, next_offset, dropped) = {
                let buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
                buf.read_from(offset)
            };
            if !bytes.is_empty() {
                collected.extend_from_slice(&bytes);
                offset = next_offset;
            }
            dropped_total = dropped_total.max(dropped);

            let text = String::from_utf8_lossy(&collected);
            if let Some(needle) = until {
                if !needle.is_empty() && text.contains(needle) {
                    return self.turn(text.into_owned(), true, offset, dropped_total);
                }
            }
            if self.exited.load(Ordering::Acquire) {
                // One last drain: the reader threads may still have been
                // flushing when the child ended.
                let (tail, last_offset, _) = self.buffer.lock().unwrap_or_else(|e| e.into_inner()).read_from(offset);
                collected.extend_from_slice(&tail);
                let text = String::from_utf8_lossy(&collected).into_owned();
                let matched = match until {
                    Some(needle) => !needle.is_empty() && text.contains(needle),
                    None => true,
                };
                return self.turn(text, matched, last_offset, dropped_total);
            }
            if Instant::now() >= deadline {
                return self.turn(text.into_owned(), until.is_none(), offset, dropped_total);
            }
            thread::sleep(Duration::from_millis(POLL_MS));
        }
    }

    fn turn(&self, output: String, matched: bool, next_offset: u64, dropped: u64) -> ReplTurn {
        ReplTurn {
            output,
            matched,
            next_offset,
            dropped,
            exited: self.exited.load(Ordering::Acquire),
            exit_code: self.exit_code_opt(),
        }
    }

    pub fn kill(&self) {
        self.close_stdin();
        crate::modules::proc::kill_tree(self.child.id());
        let _ = self.child.kill();
    }
}

impl Drop for ReplProc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
) -> Result<Arc<ReplProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !resolve_path(dir, &workspace).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let mut cmd = super::build_oneshot_command(&trimmed, &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(ref dir)) = (&workspace, &cwd) {
        cmd.current_dir(dir);
    }
    // The one line that separates this from `background::spawn`.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let shared = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?);
    #[cfg(windows)]
    let job = crate::modules::proc::job::ProcessJob::create_for(shared.id()).ok();
    let kill_on_fail = || {
        crate::modules::proc::kill_tree(shared.id());
        let _ = shared.kill();
    };
    let stdin_pipe = shared.take_stdin().ok_or_else(|| {
        kill_on_fail();
        "no stdin pipe".to_string()
    })?;
    let stdout_pipe = shared.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "no stdout pipe".to_string()
    })?;
    let stderr_pipe = shared.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "no stderr pipe".to_string()
    })?;

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let proc = Arc::new(ReplProc {
        command: trimmed,
        cwd,
        started_at_ms,
        child: shared,
        #[cfg(windows)]
        _job: job,
        stdin: Mutex::new(Some(stdin_pipe)),
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
    });

    // stdout and stderr share one buffer on purpose: a debugger writes its
    // prompt to one and its errors to the other, and reading them apart would
    // put them out of order for the reader who has to make sense of both.
    let mut reader_handles = Vec::new();
    for pipe in [
        Box::new(stdout_pipe) as Box<dyn Read + Send>,
        Box::new(stderr_pipe) as Box<dyn Read + Send>,
    ] {
        let proc_ref = proc.clone();
        let mut pipe = pipe;
        reader_handles.push(thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => proc_ref.buffer.lock().unwrap_or_else(|e| e.into_inner()).push(&buf[..n]),
                    Err(_) => break,
                }
            }
        }));
    }
    {
        let proc_ref = proc.clone();
        let child_for_wait = proc.child.clone();
        thread::spawn(move || {
            match child_for_wait.wait() {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => proc_ref.exit_unknown.store(true, Ordering::Release),
            }
            for handle in reader_handles {
                let _ = handle.join();
            }
            proc_ref.exited.store(true, Ordering::Release);
        });
    }

    Ok(proc)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell one-liner that reads one line and echoes it back with a marker,
    /// then prompts again. Written per platform because the point of these
    /// tests is the real interactive path, not a simulation of it.
    #[cfg(unix)]
    const ECHO_LOOP: &str =
        "printf 'ready> '; while read line; do echo \"GOT:$line\"; printf 'ready> '; done";
    // `[Console]::Out` rather than `Write-Host`: Write-Host goes to the console
    // host, so with stdout piped its output never arrives.
    #[cfg(windows)]
    const ECHO_LOOP: &str =
        "[Console]::Out.Write('ready> '); while ($true) { $l = [Console]::In.ReadLine(); if ($null -eq $l) { break }; [Console]::Out.WriteLine(\"GOT:$l\"); [Console]::Out.Write('ready> ') }";

    fn start(cmd: &str) -> Arc<ReplProc> {
        spawn(cmd.to_string(), None, WorkspaceEnv::Local).expect("spawn")
    }

    #[test]
    fn captures_what_the_process_prints_before_any_input() {
        let proc = start("echo hello-from-repl");
        let turn = proc.wait_for(0, Some("hello-from-repl"), Duration::from_secs(10));
        assert!(turn.matched, "output was: {:?}", turn.output);
        assert!(turn.output.contains("hello-from-repl"));
    }

    // The whole reason this module exists: a turn ends at a prompt, not at the
    // process exiting.
    #[test]
    fn a_line_gets_a_reply_and_the_process_stays_alive() {
        let proc = start(ECHO_LOOP);
        let first = proc.wait_for(0, Some("ready> "), Duration::from_secs(10));
        assert!(first.matched, "no initial prompt: {:?}", first.output);

        proc.send_line("ping").expect("send");
        let turn = proc.wait_for(first.next_offset, Some("ready> "), Duration::from_secs(10));
        assert!(turn.matched, "no prompt after input: {:?}", turn.output);
        assert!(turn.output.contains("GOT:ping"), "output: {:?}", turn.output);
        assert!(!turn.exited, "the process should still be waiting for more");
    }

    // Turns are read from a cursor so each one returns only what is new. Without
    // it every turn would re-read the whole session and grow without bound.
    #[test]
    fn a_later_turn_does_not_repeat_an_earlier_one() {
        let proc = start(ECHO_LOOP);
        let first = proc.wait_for(0, Some("ready> "), Duration::from_secs(10));
        proc.send_line("one").expect("send");
        let a = proc.wait_for(first.next_offset, Some("ready> "), Duration::from_secs(10));
        proc.send_line("two").expect("send");
        let b = proc.wait_for(a.next_offset, Some("ready> "), Duration::from_secs(10));

        assert!(a.output.contains("GOT:one"));
        assert!(b.output.contains("GOT:two"));
        assert!(!b.output.contains("GOT:one"), "second turn repeated the first");
    }

    // A timeout is an answer, not a failure: the process may simply still be
    // working, and the caller decides whether to wait again or interrupt.
    #[test]
    fn waiting_for_a_prompt_that_never_comes_returns_what_there_was() {
        let proc = start(ECHO_LOOP);
        let turn = proc.wait_for(0, Some("NEVER-APPEARS"), Duration::from_millis(600));
        assert!(!turn.matched);
        assert!(!turn.exited);
    }

    #[test]
    fn an_exited_process_is_reported_rather_than_waited_on() {
        let proc = start("echo bye");
        let turn = proc.wait_for(0, Some("NEVER-APPEARS"), Duration::from_secs(10));
        assert!(turn.exited, "should have noticed the exit");
        assert!(turn.output.contains("bye"));
    }

    #[test]
    fn writing_to_a_finished_process_says_so_instead_of_failing_silently() {
        let proc = start("echo bye");
        let _ = proc.wait_for(0, None, Duration::from_secs(10));
        let err = proc.send_line("anything").unwrap_err();
        assert!(err.contains("exited"), "unexpected error: {err}");
    }

    #[test]
    fn an_empty_command_is_refused() {
        assert!(spawn("   ".into(), None, WorkspaceEnv::Local).is_err());
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;
    use std::collections::HashMap;

    /// Mirrors the reap-then-cap that `repl_open` performs, so the rule can be
    /// checked without a Tauri State. An agent that finishes a debugging
    /// session rarely calls `repl_stop`, so without reaping the cap would be
    /// reached by processes that already exited.
    fn admit(map: &mut HashMap<u32, Arc<ReplProc>>) -> Result<(), String> {
        map.retain(|_, p| !p.exited.load(Ordering::Acquire));
        if map.len() >= MAX_LIVE {
            return Err("too many".into());
        }
        Ok(())
    }

    fn finished() -> Arc<ReplProc> {
        let p = spawn("echo done".into(), None, WorkspaceEnv::Local).expect("spawn");
        // Wait for the exit watcher rather than sleeping a fixed time.
        let _ = p.wait_for(0, None, Duration::from_secs(10));
        p
    }

    #[test]
    fn exited_processes_do_not_hold_a_slot() {
        let mut map: HashMap<u32, Arc<ReplProc>> = HashMap::new();
        for i in 0..MAX_LIVE as u32 {
            map.insert(i, finished());
        }
        assert!(admit(&mut map).is_ok(), "reaping should free every slot");
        assert!(map.is_empty());
    }

    #[test]
    fn live_processes_do_hold_a_slot() {
        let mut map: HashMap<u32, Arc<ReplProc>> = HashMap::new();
        #[cfg(unix)]
        const IDLE: &str = "sleep 30";
        #[cfg(windows)]
        const IDLE: &str = "Start-Sleep -Seconds 30";
        for i in 0..MAX_LIVE as u32 {
            map.insert(i, spawn(IDLE.into(), None, WorkspaceEnv::Local).expect("spawn"));
        }
        assert!(admit(&mut map).is_err(), "the cap should refuse a ninth");
        for p in map.values() {
            p.kill();
        }
    }
}
