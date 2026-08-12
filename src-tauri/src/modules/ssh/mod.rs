//! Interactive SSH client sessions.
//!
//! Mirrors the local PTY module's command shape (`ssh_open`/`ssh_write`/
//! `ssh_resize`/`ssh_close`) so the frontend can swap a local PTY for a
//! remote shell with minimal plumbing. Auth supports the local ssh-agent (the
//! private key stays inside the agent; Termigo only ever sees signatures), a
//! private key, or a password.
//! Host-key handling: SHA-256 fingerprint pinning. The first connect to
//! a new host is trust-on-first-use (the seen fingerprint is reported to the
//! frontend, which persists it as `lastFingerprint` in the connection store).
//! Every later connect passes that fingerprint as `expected_fingerprint`; a
//! mismatch aborts the handshake with a "host key mismatch / possible MITM"
//! error (see `session::HostKeyVerifier`). To re-trust a legitimately rotated
//! key the user clears the saved fingerprint on the connection.

mod session;
pub mod sftp;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::runtime::Runtime;

pub use session::SshEvent;
use session::SshSession;

/// Shared tokio runtime for every SSH session. russh is async-first; driving
/// it from per-session executors would duplicate thread pools. A single
/// multi-thread runtime keeps overhead flat.
fn ssh_runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("termigo-ssh")
            .build()
            .expect("init ssh tokio runtime")
    })
}

pub struct SshState {
    /// `pub(crate)` so the sibling `sftp` module can look up an existing
    /// session by id to issue file-system commands. `Arc`-wrapped so the
    /// janitor task spawned per session can hold a handle for eviction
    /// after the pump task exits on remote disconnect.
    pub(crate) sessions: Arc<tokio::sync::RwLock<HashMap<u32, Arc<SshSession>>>>,
    next_id: AtomicU32,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            next_id: AtomicU32::new(1),
        }
    }
}

/// One hop in a ProxyJump chain. Resolved on the frontend (the chain is walked
/// from saved connections and each hop's secrets are read from the keychain),
/// then passed in connect order so the backend just dials them in sequence.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpHop {
    /// Saved-connection id this hop came from, so the backend can echo it back
    /// in `JumpConnected` and the frontend pins the fingerprint on the right row.
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Authenticate this hop through the local ssh-agent. Takes precedence over
    /// the two fields below, which are then absent.
    #[serde(default)]
    pub use_agent: bool,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub expected_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOpenInput {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Authenticate through the local ssh-agent: the agent signs the handshake
    /// and the private key never reaches Termigo. One of this, `password` or
    /// `private_key` must be set.
    #[serde(default)]
    pub use_agent: bool,
    /// Plain password.
    pub password: Option<String>,
    /// PEM-encoded private key text (OpenSSH or PKCS8). Optional passphrase
    /// in `private_key_passphrase`.
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    /// SHA256 fingerprint ("SHA256:...") of the server key recorded by a
    /// previous successful connect. When set, the handshake fails fast if
    /// the server presents a different key, blocking silent MITM on saved
    /// connections. `None` on first connect (TOFU) and on dialog-time
    /// test connections for brand-new hosts.
    pub expected_fingerprint: Option<String>,
    /// ProxyJump chain in connect order (publicly-reachable entry host first;
    /// the hop closest to the target last). Empty/absent = direct connection.
    #[serde(default)]
    pub jumps: Vec<SshJumpHop>,
    pub cols: u16,
    pub rows: u16,
}

/// One key the local ssh-agent is holding. Read-only: the agent never hands out
/// the private half, so this is everything Termigo can know about it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentKey {
    /// Wire algorithm name, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// The comment the key was added with, usually `user@machine`. Often empty.
    pub comment: String,
    /// `SHA256:...`, the same form `ssh-add -l` prints.
    pub fingerprint: String,
}

/// Keys currently loaded in the local ssh-agent. Backs the connection dialog's
/// agent panel: with no field to fill in, "is the agent up and does it hold a
/// key" IS the validation for agent auth, so it is answered before saving
/// rather than at dial time.
#[tauri::command]
pub async fn ssh_agent_keys() -> Result<Vec<SshAgentKey>, String> {
    ssh_runtime()
        .spawn(async {
            let (_agent, keys) = session::agent_keys().await?;
            Ok::<_, String>(
                keys.iter()
                    .map(|k| SshAgentKey {
                        algorithm: k.algorithm().to_string(),
                        comment: k.comment().to_string(),
                        fingerprint: k.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
                    })
                    .collect(),
            )
        })
        .await
        .map_err(|e| format!("ssh agent task join failed: {e}"))?
}

#[tauri::command]
pub async fn ssh_open(
    state: tauri::State<'_, SshState>,
    input: SshOpenInput,
    on_event: Channel<SshEvent>,
) -> Result<u32, String> {
    let rt = ssh_runtime();
    let session = rt
        .spawn(session::connect(input, on_event))
        .await
        .map_err(|e| format!("ssh task join failed: {e}"))?
        .map_err(|e| {
            log::error!("ssh_open failed: {e}");
            e
        })?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    // Take the exit receiver before handing the Arc to the map so the
    // janitor can wait for the pump task to finish without racing another
    // caller for the slot. Receiver fires on normal exit (Eof/Close, peer
    // hangup) and on pump abort (because the oneshot Sender is then dropped),
    // so explicit close paths also wake the janitor; it just no-ops on the
    // already-removed id.
    let exit_signal = session.take_exit_signal();
    let sessions_handle = state.sessions.clone();
    state.sessions.write().await.insert(id, session);
    if let Some(rx) = exit_signal {
        rt.spawn(async move {
            let _ = rx.await;
            sessions_handle.write().await.remove(&id);
            log::info!("ssh session id={id} evicted after pump exit");
        });
    }
    log::info!("ssh opened id={id}");
    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(
    state: tauri::State<'_, SshState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_write: unknown id={id}");
            "no session".to_string()
        })?;
    session.write(data.as_bytes()).await
}

#[tauri::command]
pub async fn ssh_resize(
    state: tauri::State<'_, SshState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_resize: unknown id={id}");
            "no session".to_string()
        })?;
    session.resize(cols, rows).await
}

#[tauri::command]
pub async fn ssh_close(state: tauri::State<'_, SshState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write().await.remove(&id);
    if let Some(s) = session {
        s.close().await;
        log::info!("ssh closed id={id}");
    } else {
        log::debug!("ssh_close: unknown id={id}");
    }
    Ok(())
}

/// `ssh -L`: bind `127.0.0.1:local_port` on this machine and tunnel every
/// connection to `remote_host:remote_port` as resolved from the SERVER, over
/// the live session `id` (so a ProxyJump chain applies for free). `local_port`
/// 0 picks a free port; the bound port is returned for the caller to report.
///
/// No close command on purpose: forwards are declared on the saved connection
/// and re-opened on every connect, so the session's own teardown is the only
/// lifecycle they need.
#[tauri::command]
pub async fn ssh_forward_open(
    state: tauri::State<'_, SshState>,
    id: u32,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<u16, String> {
    let remote_host = remote_host.trim().to_string();
    if remote_host.is_empty() {
        return Err("ssh: port forward needs a remote host".into());
    }
    if remote_port == 0 {
        return Err("ssh: port forward needs a remote port".into());
    }
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_forward_open: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind and accept on the SSH runtime, not tauri's: the listener and the
    // russh channels it feeds must be driven by the same reactor.
    ssh_runtime()
        .spawn(async move {
            session
                .open_forward(local_port, remote_host, remote_port)
                .await
        })
        .await
        .map_err(|e| format!("ssh forward task join failed: {e}"))?
}

/// Answer a first-connect `HostKeyPrompt`. `accept = true` lets the paused
/// handshake proceed (and the connection pins the fingerprint on success);
/// `accept = false` aborts the connect before any credential is sent. Called
/// by the frontend confirmation dialog. No-op (Err) if the prompt already
/// timed out or was answered.
#[tauri::command]
pub fn ssh_confirm_host_key(prompt_id: String, accept: bool) -> Result<(), String> {
    match session::take_pending_host_key(&prompt_id) {
        Some(tx) => {
            // Receiver may already be gone if the connect timed out; ignore.
            let _ = tx.send(accept);
            Ok(())
        }
        None => Err("ssh: unknown or already-answered host-key prompt".into()),
    }
}

/// Metadata for one live SSH session, returned by `ssh_list_sessions`. Lets the
/// remote-access bridge enumerate SSH tabs the GUI has open (they live here, not
/// in the PTY daemon) before attaching to mirror them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionInfo {
    pub id: u32,
    pub host: String,
    pub user: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub created_at_ms: u64,
}

#[tauri::command]
pub async fn ssh_list_sessions(
    state: tauri::State<'_, SshState>,
) -> Result<Vec<SshSessionInfo>, String> {
    let map = state.sessions.read().await;
    let mut out = Vec::with_capacity(map.len());
    for (id, s) in map.iter() {
        let (host, user, cols, rows, alive, created_at_ms) = s.mirror_info();
        out.push(SshSessionInfo {
            id: *id,
            host,
            user,
            cols,
            rows,
            alive,
            created_at_ms,
        });
    }
    Ok(out)
}

/// Attach an additional event sink to an existing SSH session so a second
/// consumer (the remote-access bridge) mirrors its output + writes input via
/// `ssh_write`. Replays the recent ring on attach. Returns `alive`.
#[tauri::command]
pub async fn ssh_attach(
    state: tauri::State<'_, SshState>,
    id: u32,
    on_event: Channel<SshEvent>,
) -> Result<bool, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_attach: unknown id={id}");
            "no session".to_string()
        })?;
    Ok(session.add_mirror_sink(on_event))
}
#[cfg(test)]
mod tests {
    // No module-level tests yet; session.rs and sftp.rs carry the coverage.
}
