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

use serde::{Deserialize, Serialize};
use serde_json::Value;

use client::{McpClient, McpTool};

/// Project-scoped registry, relative to the workspace root.
const WORKSPACE_REGISTRY: &str = ".termigo/mcp.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
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

#[tauri::command]
pub async fn mcp_list_tools(
    workspace: Option<String>,
    server: String,
) -> Result<McpToolList, String> {
    let config = find_server(workspace_path(workspace).as_deref(), &server)?;
    let mut client = McpClient::connect(&config).await?;
    let tools = client.list_tools().await;
    client.shutdown().await;
    Ok(McpToolList {
        server,
        tools: tools?,
    })
}

#[tauri::command]
pub async fn mcp_call_tool(
    workspace: Option<String>,
    server: String,
    tool: String,
    arguments: Option<Value>,
) -> Result<Value, String> {
    let config = find_server(workspace_path(workspace).as_deref(), &server)?;
    let mut client = McpClient::connect(&config).await?;
    let result = client
        .call_tool(&tool, arguments.unwrap_or(Value::Object(Default::default())))
        .await;
    client.shutdown().await;
    result
}

#[tauri::command]
pub async fn mcp_ping(workspace: Option<String>, server: String) -> Result<bool, String> {
    let config = find_server(workspace_path(workspace).as_deref(), &server)?;
    let mut client = McpClient::connect(&config).await?;
    let alive = client.ping().await;
    client.shutdown().await;
    alive.map(|_| true)
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
