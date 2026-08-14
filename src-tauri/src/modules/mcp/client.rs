//! JSON-RPC 2.0 client for one MCP server, spoken over the child's stdio.
//!
//! MCP's stdio transport is newline-delimited JSON, not LSP-style
//! `Content-Length` framing, so a line reader is the whole protocol layer.
//!
//! Each call is a fresh connection: `initialize`, do the work, drop. Servers
//! are user-configured child processes, and keeping a pool of them alive for
//! the life of the app means holding processes the user never asked to keep
//! running. A short-lived process also cannot leak state between calls.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::timeout;

use super::ServerConfig;

/// The MCP revision this client implements.
const PROTOCOL_VERSION: &str = "2024-11-05";

/// A server that has not answered `initialize` by now is treated as broken.
///
/// The comment used to say this allowed for whatever `npx` downloads. It did
/// not: a cold `npx -y wigolo` was still fetching after four minutes here, so
/// thirty seconds failed the first launch of every npm-distributed server -
/// which is most of them - and made each one look broken.
///
/// Later runs answer in well under a second, so this ceiling is paid once per
/// package, or by a server that genuinely never speaks MCP.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(300);

/// Per-request ceiling once the server is up and talking.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Stops a server that streams unbounded output from growing the buffer without
/// limit while we wait for a reply that is never coming.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for the tool's arguments, passed through untouched.
    #[serde(default)]
    pub input_schema: Value,
}

pub struct McpClient {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

impl McpClient {
    /// Resolve a command name against PATH before spawning it.
    ///
    /// On Windows the tools MCP servers ship as - `npx`, `uvx`, `bunx` - are
    /// `.cmd` shims, and `Command::new("npx")` fails with "program not found":
    /// the standard library tries the literal name and `.exe`, never the rest
    /// of PATHEXT. Since virtually every published server is documented as
    /// `npx -y <package>`, that made MCP unusable on Windows for almost all of
    /// them. `which` applies the platform's own lookup rules, PATHEXT
    /// included.
    ///
    /// A command that is already a path, or that resolution cannot find, is
    /// passed through unchanged so the spawn error names what the user wrote
    /// rather than something this function invented.
    fn resolve_program(command: &str) -> std::ffi::OsString {
        if command.contains('/') || command.contains('\\') {
            return command.into();
        }
        which::which(command)
            .map(std::path::PathBuf::into_os_string)
            .unwrap_or_else(|_| command.into())
    }

    /// Spawn the server and complete the MCP handshake.
    pub async fn connect(config: &ServerConfig) -> Result<Self, String> {
        let mut command = Command::new(Self::resolve_program(&config.command));
        command
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &config.env {
            command.env(key, value);
        }
        if let Some(dir) = &config.cwd {
            command.current_dir(dir);
        }
        // A user-configured server is still a child process: no console window
        // should flash over the app when it starts.
        // tokio's Command exposes creation_flags directly on Windows.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("cannot start MCP server '{}': {e}", config.name))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP server stdout unavailable".to_string())?;

        let mut client = Self {
            child,
            stdin,
            reader: BufReader::new(stdout),
            next_id: 0,
        };

        let handshake = client.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "Termigo", "version": env!("CARGO_PKG_VERSION") },
            }),
            HANDSHAKE_TIMEOUT,
        );
        match handshake.await {
            Ok(_) => {}
            Err(error) => {
                let detail = client.drain_stderr().await;
                let _ = client.child.kill().await;
                // A server still downloading on first run and one that will
                // never speak MCP fail identically, and the difference decides
                // whether the user waits or fixes the command. Say so when
                // there is no output to go on.
                return Err(if detail.is_empty() {
                    format!(
                        "{error}. It printed nothing, which usually means the command \
                         does not start an MCP server, or a first run is still \
                         downloading. Try running it once in a terminal first."
                    )
                } else {
                    format!("{error} (server said: {detail})")
                });
            }
        }
        // MCP requires this acknowledgement before any other request.
        client
            .notify("notifications/initialized", json!({}))
            .await?;
        Ok(client)
    }

    pub async fn list_tools(&mut self) -> Result<Vec<McpTool>, String> {
        let result = self
            .request("tools/list", json!({}), REQUEST_TIMEOUT)
            .await?;
        let tools = result.get("tools").cloned().unwrap_or_else(|| json!([]));
        serde_json::from_value(tools).map_err(|e| format!("bad tools/list response: {e}"))
    }

    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    pub async fn ping(&mut self) -> Result<(), String> {
        self.request("ping", json!({}), REQUEST_TIMEOUT)
            .await
            .map(|_| ())
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_line(&message).await?;

        match timeout(limit, self.read_response(id)).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "MCP server did not answer '{method}' within {}s",
                limit.as_secs()
            )),
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.write_line(&message).await
    }

    async fn write_line(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("cannot write to MCP server: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("cannot flush to MCP server: {e}"))
    }

    /// Read until the reply with `id` arrives.
    ///
    /// Servers interleave notifications and log lines with responses, so
    /// anything that is not our reply is skipped rather than treated as one.
    async fn read_response(&mut self, id: u64) -> Result<Value, String> {
        loop {
            let mut line = String::new();
            let read = self
                .reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("cannot read from MCP server: {e}"))?;
            if read == 0 {
                return Err("MCP server closed the connection".to_string());
            }
            if line.len() > MAX_LINE_BYTES {
                return Err("MCP server sent an oversized message".to_string());
            }
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                continue; // not JSON: a log line on stdout
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue; // a notification, or an answer to something else
            }
            if let Some(error) = message.get("error") {
                let text = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error");
                return Err(format!("MCP server returned an error: {text}"));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Best-effort stderr text, used to explain a failed handshake.
    async fn drain_stderr(&mut self) -> String {
        let Some(stderr) = self.child.stderr.take() else {
            return String::new();
        };
        let mut reader = BufReader::new(stderr);
        let mut text = String::new();
        for _ in 0..20 {
            let mut line = String::new();
            match timeout(Duration::from_millis(200), reader.read_line(&mut line)).await {
                Ok(Ok(n)) if n > 0 => text.push_str(line.trim_end()),
                _ => break,
            }
            text.push(' ');
        }
        text.trim().chars().take(500).collect()
    }

    pub async fn shutdown(mut self) {
        let _ = self.child.kill().await;
    }
}

/// Merge configured env over the inherited one, matching the Go CLI.
pub fn env_for(overrides: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    for (key, value) in overrides {
        env.insert(key.clone(), value.clone());
    }
    env
}
