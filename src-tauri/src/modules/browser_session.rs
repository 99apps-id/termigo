//! Persistent Chromium sessions the agent drives over the DevTools protocol.
//!
//! A named session keeps its profile directory under `~/.termigo/browser-sessions`,
//! so cookies and logins survive across runs. The URL guard is the same
//! `unsafe_url` policy the embedded browser uses.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::modules::browser::unsafe_url;

const MAX_TEXT_CHARS: usize = 20_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub profile_dir: String,
    pub port: u16,
    pub url: String,
    pub headful: bool,
}

struct Live {
    info: SessionInfo,
    _child: Child,
}

static LIVE: OnceLock<Mutex<HashMap<String, Live>>> = OnceLock::new();

fn live() -> &'static Mutex<HashMap<String, Live>> {
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sessions_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".termigo").join("browser-sessions"))
        .ok_or_else(|| "could not resolve home directory".to_string())
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("session name must be 1-64 ASCII letters, digits, '_' or '-'".to_string());
    }
    Ok(())
}

fn browser_executable() -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(|var| std::env::var(var).ok())
            .flat_map(|base| {
                [
                    PathBuf::from(&base).join("Google/Chrome/Application/chrome.exe"),
                    PathBuf::from(&base).join("Microsoft/Edge/Application/msedge.exe"),
                ]
            })
            .collect()
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/bin/google-chrome"),
            PathBuf::from("/usr/bin/chromium"),
            PathBuf::from("/usr/bin/microsoft-edge"),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Chrome, Chromium or Edge was not found".to_string())
}

async fn free_port() -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| e.to_string())
}

async fn launch(profile: &Path, url: &str, headful: bool) -> Result<(Child, u16), String> {
    let exe = browser_executable()?;
    let mut last = String::from("browser did not start");
    for _ in 0..3 {
        let port = free_port().await?;
        let mut cmd = Command::new(&exe);
        cmd.args([
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-address=127.0.0.1",
            &format!("--remote-debugging-port={port}"),
            &format!("--user-data-dir={}", profile.display()),
        ]);
        if headful {
            cmd.arg("--disable-blink-features=AutomationControlled");
        } else {
            cmd.arg("--headless=new");
        }
        cmd.arg(url).kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                last = e.to_string();
                continue;
            }
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                last = format!("browser exited during startup (port {port})");
                break;
            }
            let ready = tokio::time::timeout(
                Duration::from_secs(2),
                reqwest::get(format!("http://127.0.0.1:{port}/json/version")),
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
            if ready {
                return Ok((child, port));
            }
            if tokio::time::Instant::now() >= deadline {
                last = format!("browser did not expose its debugging port ({port})");
                let _ = child.kill().await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    Err(format!("could not start a browser session: {last}"))
}

async fn page_socket(port: u16) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(response) = reqwest::get(format!("http://127.0.0.1:{port}/json")).await {
            if let Ok(targets) = response.json::<Vec<Value>>().await {
                let socket = targets
                    .iter()
                    .find(|t| t["type"].as_str() == Some("page"))
                    .and_then(|t| t["webSocketDebuggerUrl"].as_str());
                if let Some(socket) = socket {
                    return Ok(socket.to_string());
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("no active browser tab".to_string());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn cdp(port: u16, method: &str, params: Value) -> Result<Value, String> {
    let socket = page_socket(port).await?;
    let (mut ws, _) = tokio_tungstenite::connect_async(socket)
        .await
        .map_err(|e| e.to_string())?;
    ws.send(Message::Text(
        json!({ "id": 1, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let next = tokio::time::timeout_at(deadline, ws.next())
            .await
            .map_err(|_| format!("CDP timeout waiting for {method}"))?;
        let message = next
            .ok_or_else(|| "CDP connection closed".to_string())?
            .map_err(|e| e.to_string())?;
        let Message::Text(text) = message else {
            continue;
        };
        let frame: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if frame["id"].as_i64() != Some(1) {
            continue;
        }
        if let Some(error) = frame.get("error") {
            let message = error["message"].as_str().unwrap_or("unknown error");
            return Err(format!("{method} failed: {message}"));
        }
        return Ok(frame["result"].clone());
    }
}

async fn eval(port: u16, expression: &str) -> Result<Value, String> {
    let result = cdp(
        port,
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true, "awaitPromise": false }),
    )
    .await?;
    if let Some(exception) = result.get("exceptionDetails") {
        let text = exception["exception"]["description"]
            .as_str()
            .or_else(|| exception["text"].as_str())
            .unwrap_or("page evaluation failed");
        return Err(text.to_string());
    }
    Ok(result["result"]["value"].clone())
}

async fn port_of(session_id: &str) -> Result<u16, String> {
    live()
        .lock()
        .await
        .get(session_id)
        .map(|l| l.info.port)
        .ok_or_else(|| format!("session '{session_id}' is not live; create it first"))
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

#[tauri::command]
pub async fn browser_session_create(
    name: Option<String>,
    url: String,
    headful: Option<bool>,
) -> Result<SessionInfo, String> {
    if url != "about:blank" {
        if let Some(reason) = unsafe_url(&url) {
            return Err(format!("Refused: {reason}"));
        }
    }
    let headful = headful.unwrap_or(false);
    let session_id = match name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => {
            valid_id(name)?;
            name.to_string()
        }
        None => format!("session_{}", uuid::Uuid::new_v4().simple()),
    };

    if let Some(existing) = live().lock().await.get(&session_id) {
        return Ok(existing.info.clone());
    }

    let profile = sessions_root()?.join(&session_id);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let (child, port) = launch(&profile, &url, headful).await?;
    let info = SessionInfo {
        session_id: session_id.clone(),
        profile_dir: profile.display().to_string(),
        port,
        url,
        headful,
    };
    live().lock().await.insert(
        session_id,
        Live {
            info: info.clone(),
            _child: child,
        },
    );
    Ok(info)
}

#[derive(Serialize)]
pub struct SessionList {
    pub live: Vec<SessionInfo>,
    pub saved_profiles: Vec<String>,
}

#[tauri::command]
pub async fn browser_session_list() -> Result<SessionList, String> {
    let live_sessions = live()
        .lock()
        .await
        .values()
        .map(|l| l.info.clone())
        .collect();
    let saved_profiles = match sessions_root() {
        Ok(root) => std::fs::read_dir(root)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Ok(SessionList {
        live: live_sessions,
        saved_profiles,
    })
}

#[tauri::command]
pub async fn browser_session_navigate(session_id: String, url: String) -> Result<Value, String> {
    if let Some(reason) = unsafe_url(&url) {
        return Err(format!("Refused: {reason}"));
    }
    let port = port_of(&session_id).await?;
    cdp(port, "Page.navigate", json!({ "url": url })).await?;
    let started = tokio::time::Instant::now();
    let mut ready = false;
    while started.elapsed() < Duration::from_secs(10) {
        if eval(port, "document.readyState").await? == json!("complete") {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let current = eval(port, "location.href").await?;
    let title = eval(port, "document.title").await?;
    Ok(json!({ "url": current, "title": title, "ready": ready }))
}

#[tauri::command]
pub async fn browser_session_text(session_id: String) -> Result<Value, String> {
    let port = port_of(&session_id).await?;
    let expression = format!(
        "(()=>({{title:document.title,url:location.href,text:(document.body?document.body.innerText:'').slice(0,{MAX_TEXT_CHARS})}}))()"
    );
    eval(port, &expression).await
}

#[tauri::command]
pub async fn browser_session_click(session_id: String, selector: String) -> Result<Value, String> {
    let port = port_of(&session_id).await?;
    let expression = format!(
        "(()=>{{const e=document.querySelector({});if(!e)return false;e.scrollIntoView({{block:'center'}});e.click();return true}})()",
        quoted(&selector)
    );
    let started = tokio::time::Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if eval(port, &expression).await? == json!(true) {
            return Ok(json!({ "clicked": true }));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!(
        "no element matched selector '{selector}' within 5s"
    ))
}

#[tauri::command]
pub async fn browser_session_type(
    session_id: String,
    selector: String,
    text: String,
) -> Result<Value, String> {
    let port = port_of(&session_id).await?;
    let expression = format!(
        "(()=>{{const e=document.querySelector({sel});if(!e)throw new Error('no element matched selector');e.focus();const proto=Object.getPrototypeOf(e);const desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc&&desc.set){{desc.set.call(e,{val});}}else{{e.value={val};}}e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));return true}})()",
        sel = quoted(&selector),
        val = quoted(&text),
    );
    eval(port, &expression).await?;
    Ok(json!({ "typed": text.chars().count() }))
}

#[tauri::command]
pub async fn browser_session_close(session_id: String) -> Result<(), String> {
    live()
        .lock()
        .await
        .remove(&session_id)
        .map(|_| ())
        .ok_or_else(|| format!("session '{session_id}' is not live"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_names_reject_traversal_and_separators() {
        assert!(valid_id("instagram").is_ok());
        assert!(valid_id("my-profile_2").is_ok());
        assert!(valid_id("../escape").is_err());
        assert!(valid_id("nested/name").is_err());
        assert!(valid_id("").is_err());
        assert!(valid_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn quoted_escapes_selector_for_js() {
        assert_eq!(quoted("a\"b"), "\"a\\\"b\"");
    }
}
