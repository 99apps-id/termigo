use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};
use tokio::time::timeout;

use super::session::{self, Session};
use super::shell_init;
use super::PtyState;
use crate::modules::control::ControlState;
use crate::modules::workspace::{user_spawn_cwd_or_home, WorkspaceEnv, WorkspaceRegistry};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    control: tauri::State<'_, ControlState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    pane_id: Option<u32>,
    persist: Option<bool>,
    persist_key: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u64, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let blocks = blocks.unwrap_or(false);
    let persist = persist.unwrap_or(false);
    let cwd = user_spawn_cwd_or_home(&registry, cwd.as_deref(), &workspace);
    // A Windows helper cannot execute inside WSL without explicit path and
    // network translation. Do not inject credentials for a broken command.
    let control_env = if workspace.is_wsl() {
        None
    } else {
        pane_id.and_then(|pane_id| control.shell_env(pane_id))
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    const SPAWN_TIMEOUT: Duration = Duration::from_secs(15);
    let join_handle = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(
            id,
            app,
            cols,
            rows,
            cwd,
            workspace,
            blocks,
            shell,
            control_env,
            persist,
            persist_key,
            on_data,
            on_exit,
        )
        .map(|(s, _)| s)
    });
    let timeout_result = timeout(SPAWN_TIMEOUT, join_handle).await;
    let join_output = match timeout_result {
        Ok(inner) => inner,
        Err(_) => {
            log::error!("pty_open timed out after 15s");
            return Err(
                "pty_open timed out after 15s - shell may be misconfigured or profile corrupt"
                    .to_string(),
            );
        }
    };
    let spawn_result = join_output.map_err(|e| e.to_string())?;
    let inner = spawn_result.map_err(|e| e.to_string())?;
    state.sessions.write().unwrap().insert(id, inner);
    // The shell can exit before this insert (instant failure, `exit` in an rc
    // file); the waiter's reap then ran with the id absent. Re-check and reap
    // so the pseudoconsole isn't stranded.
    let exited = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .map(|s| s.exited.load(Ordering::Acquire))
        .unwrap_or(false);
    if exited {
        if let Some(s) = state.take(id) {
            thread::Builder::new()
                .name(format!("termigo-pty-drop-{id}"))
                .spawn(move || session::drop_session(s))
                .expect("spawn pty drop thread");
        }
    }
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

/// Reject oversized input before it reaches the PTY writer.
///
/// Terminal input is keystrokes and paste, so a few MiB covers any realistic
/// paste while refusing a runaway frontend before it can push megabytes at a
/// PTY whose child is not draining. Split out so the limit is asserted
/// directly, without an IPC round trip.
fn check_input_size(len: usize) -> Result<(), String> {
    if len > MAX_INPUT_BYTES {
        return Err(format!(
            "pty_write: {len} bytes exceeds the {MAX_INPUT_BYTES}-byte limit"
        ));
    }
    Ok(())
}

// Input is the latency-critical path: raw body + id header skips JSON
// serialization of every keystroke on both sides of the IPC boundary.
#[tauri::command]
pub fn pty_write(
    state: tauri::State<PtyState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let id: u64 = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "pty_write: missing x-pty-id header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pty_write: expected raw body".to_string());
    };
    if let Err(e) = check_input_size(bytes.len()) {
        log::warn!("pty_write id={id}: {e}");
        return Err(e);
    }
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(bytes)
        .map_err(|e| {
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u64) -> Result<(), String> {
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        thread::Builder::new()
            .name(format!("termigo-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

#[tauri::command]
pub fn pty_has_foreground_process(state: tauri::State<PtyState>, id: u64) -> Result<bool, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_process: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    Ok(shell_has_children(shell_pid))
}

#[tauri::command]
pub fn pty_has_foreground_job(state: tauri::State<PtyState>, id: u64) -> Result<bool, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_job: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let leader = session.master.lock().unwrap().process_group_leader();
        Ok(matches!(leader, Some(pid) if pid > 0 && (pid as u64) != shell_pid))
    }
    #[cfg(windows)]
    {
        Ok(shell_has_children(shell_pid))
    }
}

#[cfg(unix)]
fn shell_has_children(shell_pid: u64) -> bool {
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn shell_has_children(shell_pid: u64) -> bool {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32 = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32>() as u32;
        let mut found = false;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == shell_pid as u32 {
                    found = true;
                    break;
                }
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let drained: Vec<(u64, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, s) in drained {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        thread::Builder::new()
            .name(format!("termigo-pty-drop-{id}"))
            .spawn(move || session::drop_session(s))
            .expect("spawn pty drop thread");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

#[tauri::command]
pub fn pty_shell_name() -> String {
    shell_init::detect_shell_name()
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<shell_init::ShellInfo> {
    shell_init::list_shells()
}

#[tauri::command]
pub fn pty_persist_available() -> bool {
    shell_init::persist_available()
}

/// Releases output-credit for a session up to the cumulative byte mark the
/// frontend reports it has consumed.
///
/// The mark is cumulative and monotonic, so a repeat or an overtaken ack is a
/// no-op rather than an error. An ack for an unknown session is also a no-op:
/// the session may have closed between the frontend sending the ack and this
/// running. Releasing wakes any flusher parked on a full window.
#[tauri::command]
pub async fn pty_ack_output(
    id: u64,
    bytes: u64,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state.sessions.read().unwrap().get(&id).cloned();
    let Some(session) = session else {
        return Ok(());
    };
    session
        .output
        .lock()
        .map_err(|e| e.to_string())?
        .acknowledge(bytes);
    session.output_cv.notify_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check_input_size, MAX_INPUT_BYTES};

    #[test]
    fn accepts_input_at_the_limit() {
        assert!(check_input_size(MAX_INPUT_BYTES).is_ok());
    }

    #[test]
    fn rejects_input_past_the_limit() {
        assert!(check_input_size(MAX_INPUT_BYTES + 1).is_err());
    }

    #[test]
    fn accepts_keystrokes_and_ordinary_paste() {
        assert!(check_input_size(0).is_ok());
        assert!(check_input_size(64 * 1024).is_ok());
    }
}
