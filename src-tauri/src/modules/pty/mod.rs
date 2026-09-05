mod agent_detect;
pub mod commands;
mod da_filter;
mod session;
pub(crate) mod shell_init;

pub use commands::*;

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, RwLock};

use session::Session;

pub struct PtyState {
    pub(crate) sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    pub(crate) next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl PtyState {
    pub(crate) fn take(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.write().unwrap().remove(&id)
    }
}
