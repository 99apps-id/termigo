//! MCP (Model Context Protocol) servers.
//!
//! Reads the standard `mcpServers` registry from `<workspace>/.termigo/mcp.json`
//! merged with the user-level `~/.termigo/mcp.json`, and talks JSON-RPC 2.0
//! over stdio to each server. This is the same registry shape and merge order
//! the Go companion CLI uses, so a server configured for one works in the other.
//!
//! Project entries win over user entries with the same name: the closer config
//! is the more specific one.

pub mod client;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use client::{McpClient, McpTool};

/// Project-scoped registry, relative to the workspace root.
const WORKSPACE_REGISTRY: &str = ".termigo/mcp.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// "project" or "user", for display and for the merge rule.
    pub scope: String,
    /// Working directory for the child, set to the workspace for project scope.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// The on-disk shape: `{ "mcpServers": { "<name>": { command, args, env } } }`.
#[derive(Deserialize)]
struct RegistryFile {
    #[serde(default, rename = "mcpServers")]
    servers: HashMap<String, RegistryEntry>,
}

#[derive(Deserialize)]
struct RegistryEntry {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

fn read_registry(path: &Path, scope: &str, cwd: Option<&Path>) -> Vec<ServerConfig> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new(); // absent registry is not an error
    };
    let Ok(file) = serde_json::from_str::<RegistryFile>(&text) else {
        log::warn!("mcp: ignoring malformed registry at {}", path.display());
        return Vec::new();
    };
    file.servers
        .into_iter()
        .map(|(name, entry)| ServerConfig {
            name,
            command: entry.command,
            args: entry.args,
            env: entry.env,
            scope: scope.to_string(),
            cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
        })
        .collect()
}

fn user_registry_path() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("TERMIGO_HOME") {
        return Some(PathBuf::from(home).join("mcp.json"));
    }
    dirs::home_dir().map(|dir| dir.join(".termigo").join("mcp.json"))
}

/// Edit the user-level registry in place, preserving entries this app does not
/// manage.
///
/// Read-modify-write on the parsed JSON rather than rewriting from a struct:
/// the file is shared with the Go companion CLI and hand-edited by users, and
/// a rewrite would silently drop any key a future version adds.
fn edit_user_registry<F>(mutate: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Map<String, Value>) -> Result<(), String>,
{
    let path = user_registry_path().ok_or_else(|| "no home directory".to_string())?;
    let mut root: Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?,
        Err(_) => serde_json::json!({}),
    };
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().expect("object above");
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !servers.is_object() {
        *servers = Value::Object(serde_json::Map::new());
    }
    mutate(servers.as_object_mut().expect("object above"))?;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    // Written via a temp file and renamed: a half-written registry would be
    // unparseable, and this file is the only record of the user's servers.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{body}
")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Add or replace a user-level server.
#[tauri::command]
pub async fn mcp_add_server(
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("a server needs a name".into());
    }
    if command.trim().is_empty() {
        return Err("a server needs a command".into());
    }
    edit_user_registry(move |servers| {
        let mut entry = serde_json::Map::new();
        entry.insert("command".into(), Value::String(command.trim().to_string()));
        if !args.is_empty() {
            entry.insert(
                "args".into(),
                Value::Array(args.into_iter().map(Value::String).collect()),
            );
        }
        if !env.is_empty() {
            entry.insert(
                "env".into(),
                Value::Object(env.into_iter().map(|(k, v)| (k, Value::String(v))).collect()),
            );
        }
        servers.insert(trimmed, Value::Object(entry));
        Ok(())
    })?;
    // The pooled process was started from the entry this just replaced.
    clear_pool();
    Ok(())
}

/// Remove a user-level server. A project-scope entry of the same name is left
/// alone: it lives in the workspace file, which this does not touch.
#[tauri::command]
pub async fn mcp_remove_server(name: String) -> Result<(), String> {
    edit_user_registry(move |servers| {
        servers.remove(&name);
        Ok(())
    })?;
    clear_pool();
    Ok(())
}

/// Merged registry for a workspace, sorted by name.
pub fn load_servers(workspace: Option<&Path>) -> Vec<ServerConfig> {
    let mut by_name: HashMap<String, ServerConfig> = HashMap::new();

    if let Some(path) = user_registry_path() {
        for server in read_registry(&path, "user", None) {
            by_name.insert(server.name.clone(), server);
        }
    }
    // Project entries are inserted second so they replace a user entry of the
    // same name.
    if let Some(root) = workspace {
        for server in read_registry(&root.join(WORKSPACE_REGISTRY), "project", Some(root)) {
            by_name.insert(server.name.clone(), server);
        }
    }

    let mut servers: Vec<ServerConfig> = by_name.into_values().collect();
    servers.sort_by_key(|s| s.name.to_lowercase());
    servers
}

fn find_server(workspace: Option<&Path>, name: &str) -> Result<ServerConfig, String> {
    load_servers(workspace)
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("no MCP server named '{name}' is configured"))
}

fn workspace_path(workspace: Option<String>) -> Option<PathBuf> {
    workspace
        .filter(|w| !w.trim().is_empty())
        .map(PathBuf::from)
}

// ---- Commands -------------------------------------------------------------

#[tauri::command]
pub async fn mcp_list_servers(workspace: Option<String>) -> Result<Vec<ServerConfig>, String> {
    Ok(load_servers(workspace_path(workspace).as_deref()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolList {
    pub server: String,
    pub tools: Vec<McpTool>,
}

/// One server's live connection. `None` until first use, and again after a
/// transport failure so the next call starts a fresh process.
type Slot = Arc<AsyncMutex<Option<McpClient>>>;

/// Live servers, keyed by name.
///
/// Every command used to `connect`, do one thing, and `shutdown` - so an
/// `npx -y wigolo` was spawned, handshaked and killed for each tool listing
/// and again for each tool call. Measured cold that is ~19s before the first
/// message reaches the model, and ~2s on every call after; the handshake
/// timeout is five minutes precisely because npx can be that slow.
///
/// Servers now stay up. The first message still pays the startup once, and
/// nothing after it does. `kill_on_drop(true)` on the child means dropping an
/// entry stops the process, so replacing or clearing the pool cleans up.
static POOL: OnceLock<StdMutex<HashMap<String, (Slot, ServerConfig)>>> = OnceLock::new();

/// Errors that mean the pipe is gone rather than the tool being unhappy. A
/// tool that rejects its arguments answers over a healthy connection and must
/// not cost a restart; a closed pipe must.
fn is_transport_failure(error: &str) -> bool {
    error.contains("cannot write to MCP server")
        || error.contains("cannot flush to MCP server")
        || error.contains("cannot read from MCP server")
        || error.contains("MCP server closed the connection")
        || error.contains("did not respond")
}

/// A locked, connected server.
///
/// Locking the slot serialises calls to that server, which stdio requires:
/// one pipe, one request at a time. The guard is owned so it can outlive the
/// function that produced it.
struct Session {
    guard: tokio::sync::OwnedMutexGuard<Option<McpClient>>,
}

impl Session {
    fn client(&mut self) -> &mut McpClient {
        self.guard.as_mut().expect("connected in `session`")
    }

    /// Pass the call's result through, dropping the server first if the pipe
    /// is what broke. Dropping kills the child, so the next call gets a fresh
    /// one instead of talking to a corpse forever.
    fn finish<T>(mut self, result: Result<T, String>) -> Result<T, String> {
        if let Err(e) = &result {
            if is_transport_failure(e) {
                *self.guard = None;
            }
        }
        result
    }
}

/// Get the pooled server for `name`, starting the process if it is not up.
///
/// The pool lock is held only long enough to hand back the slot - never across
/// a handshake - so a slow start on one server does not block another.
async fn session(workspace: Option<String>, name: &str) -> Result<Session, String> {
    let config = find_server(workspace_path(workspace).as_deref(), name)?;
    let pool = POOL.get_or_init(|| StdMutex::new(HashMap::new()));

    let slot: Slot = {
        let mut map = pool.lock().map_err(|_| "mcp pool poisoned".to_string())?;
        match map.get(name) {
            // A changed command, args or env means the running process is not
            // the one the user configured. Replacing the entry drops the old
            // handle, which kills it.
            Some((slot, known)) if known == &config => slot.clone(),
            _ => {
                let slot: Slot = Arc::new(AsyncMutex::new(None));
                map.insert(name.to_string(), (slot.clone(), config.clone()));
                slot
            }
        }
    };

    let mut guard = slot.lock_owned().await;
    if guard.is_none() {
        *guard = Some(McpClient::connect(&config).await?);
    }
    Ok(Session { guard })
}

/// Stop every pooled server. Called when the registry changes, so an edited or
/// removed entry does not keep serving from the process it used to describe.
fn clear_pool() {
    if let Some(pool) = POOL.get() {
        if let Ok(mut map) = pool.lock() {
            map.clear();
        }
    }
}

#[tauri::command]
pub async fn mcp_list_tools(
    workspace: Option<String>,
    server: String,
) -> Result<McpToolList, String> {
    let mut s = session(workspace, &server).await?;
    let listed = s.client().list_tools().await;
    Ok(McpToolList {
        server,
        tools: s.finish(listed)?,
    })
}

#[tauri::command]
pub async fn mcp_call_tool(
    workspace: Option<String>,
    server: String,
    tool: String,
    arguments: Option<Value>,
) -> Result<Value, String> {
    let args = arguments.unwrap_or(Value::Object(Default::default()));
    let mut s = session(workspace, &server).await?;
    let called = s.client().call_tool(&tool, args).await;
    s.finish(called)
}

#[tauri::command]
pub async fn mcp_ping(workspace: Option<String>, server: String) -> Result<bool, String> {
    let mut s = session(workspace, &server).await?;
    let pinged = s.client().ping().await;
    s.finish(pinged).map(|_| true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_registry(dir: &Path, body: &str) -> PathBuf {
        let termigo = dir.join(".termigo");
        std::fs::create_dir_all(&termigo).unwrap();
        let path = termigo.join("mcp.json");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        path
    }

    #[test]
    fn reads_the_standard_mcp_shape() {
        let dir = tempfile::tempdir().unwrap();
        write_registry(
            dir.path(),
            r#"{"mcpServers":{"fs":{"command":"npx","args":["-y","server-filesystem","."],"env":{"A":"1"}}}}"#,
        );
        let servers = read_registry(
            &dir.path().join(WORKSPACE_REGISTRY),
            "project",
            Some(dir.path()),
        );
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "fs");
        assert_eq!(servers[0].command, "npx");
        assert_eq!(servers[0].args.len(), 3);
        assert_eq!(servers[0].env.get("A").map(String::as_str), Some("1"));
        assert_eq!(servers[0].scope, "project");
        assert!(servers[0].cwd.is_some());
    }

    /// A missing registry is the normal case for a workspace that never
    /// configured one, and a malformed one must not take the app down with it.
    #[test]
    fn absent_or_malformed_registries_yield_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_registry(&dir.path().join("nope.json"), "project", None).is_empty());
        write_registry(dir.path(), "{ not json");
        assert!(
            read_registry(&dir.path().join(WORKSPACE_REGISTRY), "project", None).is_empty()
        );
    }

    #[test]
    fn project_scope_overrides_user_scope_for_the_same_name() {
        let dir = tempfile::tempdir().unwrap();
        write_registry(
            dir.path(),
            r#"{"mcpServers":{"shared":{"command":"project-cmd"}}}"#,
        );
        let mut by_name: HashMap<String, ServerConfig> = HashMap::new();
        by_name.insert(
            "shared".into(),
            ServerConfig {
                name: "shared".into(),
                command: "user-cmd".into(),
                args: vec![],
                env: HashMap::new(),
                scope: "user".into(),
                cwd: None,
            },
        );
        for server in read_registry(
            &dir.path().join(WORKSPACE_REGISTRY),
            "project",
            Some(dir.path()),
        ) {
            by_name.insert(server.name.clone(), server);
        }
        assert_eq!(by_name["shared"].command, "project-cmd");
        assert_eq!(by_name["shared"].scope, "project");
    }
}
