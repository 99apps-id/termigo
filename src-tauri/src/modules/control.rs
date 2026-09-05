use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use termigo_control_protocol::{ControlDescriptor, FrontendResponse, PROTOCOL_VERSION};

use crate::modules::fs;

mod launcher;
mod router;
mod server;
mod validation;

pub use router::{control_frontend_ready, control_respond};

#[derive(Clone)]
pub(crate) struct RuntimeInfo {
    pub(crate) address: String,
    pub(crate) token: String,
    pub(crate) descriptor_path: PathBuf,
    pub(crate) cli_path: Option<PathBuf>,
    pub(crate) launcher_dir: Option<PathBuf>,
}

pub(crate) struct ControlCore {
    pub(crate) runtime: OnceLock<RuntimeInfo>,
    pub(crate) frontend_ready: AtomicBool,
    pub(crate) shutting_down: AtomicBool,
    pub(crate) active_connections: AtomicUsize,
    pub(crate) pending: Mutex<HashMap<String, SyncSender<FrontendResponse>>>,
}

#[derive(Clone)]
pub struct ControlState(pub(crate) Arc<ControlCore>);

impl Default for ControlState {
    fn default() -> Self {
        Self(Arc::new(ControlCore {
            runtime: OnceLock::new(),
            frontend_ready: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            active_connections: AtomicUsize::new(0),
            pending: Mutex::new(HashMap::new()),
        }))
    }
}

#[derive(Clone)]
pub struct ShellControlEnv {
    pub address: String,
    pub token: String,
    pub pane_id: u32,
    pub cli_path: Option<String>,
    pub cli_bin_dir: Option<PathBuf>,
}

impl ControlState {
    pub fn shell_env(&self, pane_id: u32) -> Option<ShellControlEnv> {
        if self.0.shutting_down.load(Ordering::Acquire) {
            return None;
        }
        let runtime = self.0.runtime.get()?;
        if self.0.shutting_down.load(Ordering::Acquire) {
            return None;
        }
        Some(ShellControlEnv {
            address: runtime.address.clone(),
            token: runtime.token.clone(),
            pane_id,
            cli_path: runtime.cli_path.as_ref().map(fs::to_canon),
            cli_bin_dir: runtime.launcher_dir.clone(),
        })
    }

    pub fn shutdown(&self) {
        self.0.shutting_down.store(true, Ordering::Release);
        self.0.frontend_ready.store(false, Ordering::Release);
        if let Some(runtime) = self.0.runtime.get() {
            launcher::remove_own_descriptor(&runtime.descriptor_path, &runtime.token);
            if let Some(dir) = &runtime.launcher_dir {
                launcher::remove_launcher_dir(dir);
            }
        }
    }

    pub(crate) fn release_connection(&self) {
        self.0.active_connections.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn start(app: tauri::AppHandle, state: ControlState) -> Result<(), String> {
    if state.0.runtime.get().is_some() {
        return Err("control server already initialized".to_string());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("bind local control socket: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("read local control address: {error}"))?
        .to_string();
    let token = launcher::generate_token()?;
    let descriptor_path = launcher::descriptor_path()?;
    launcher::sweep_stale_launcher_dirs(&descriptor_path);
    let cli_path = launcher::find_bundled_cli();
    let launcher_dir = cli_path.as_deref().and_then(|cli_path| {
        match launcher::prepare_cli_launcher(&descriptor_path, cli_path) {
            Ok(dir) => Some(dir),
            Err(error) => {
                log::warn!("could not prepare termigo CLI launcher: {error}");
                None
            }
        }
    });

    let descriptor = ControlDescriptor {
        protocol: PROTOCOL_VERSION,
        address: address.clone(),
        token: token.clone(),
        pid: std::process::id(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    if let Err(error) = launcher::write_descriptor(&descriptor_path, &descriptor) {
        if let Some(dir) = &launcher_dir {
            launcher::remove_launcher_dir(dir);
        }
        return Err(error);
    }

    if let Err(runtime) = state.0.runtime.set(RuntimeInfo {
        address,
        token,
        descriptor_path,
        cli_path: cli_path.clone(),
        launcher_dir,
    }) {
        launcher::remove_own_descriptor(&runtime.descriptor_path, &runtime.token);
        if let Some(dir) = &runtime.launcher_dir {
            launcher::remove_launcher_dir(dir);
        }
        return Err("control server already initialized".to_string());
    }

    if cli_path.is_none() {
        log::warn!("bundled termigo-cli executable not found; shell alias disabled");
    }

    let listener_state = state.clone();
    if let Err(error) = thread::Builder::new()
        .name("termigo-control-listener".into())
        .stack_size(server::LISTENER_STACK_BYTES)
        .spawn(move || server::accept_loop(listener, app, listener_state))
    {
        state.shutdown();
        return Err(format!("spawn control listener: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_stops_advertising_shell_credentials() {
        let state = ControlState::default();
        assert!(state
            .0
            .runtime
            .set(RuntimeInfo {
                address: "127.0.0.1:4312".into(),
                token: "a".repeat(64),
                descriptor_path: PathBuf::from("unused-control.json"),
                cli_path: None,
                launcher_dir: None,
            })
            .is_ok());
        assert!(state.shell_env(7).is_some());
        state.shutdown();
        assert!(state.shell_env(7).is_none());
    }
}
