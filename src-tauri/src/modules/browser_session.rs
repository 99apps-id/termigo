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
use crate::modules::fs::security::guard_write;

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
    eval_ext(port, expression, false).await
}

async fn eval_ext(port: u16, expression: &str, await_promise: bool) -> Result<Value, String> {
    let result = cdp(
        port,
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true, "awaitPromise": await_promise }),
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
    // browser_session_resume needs to know where to go back to; the profile
    // itself carries the cookies, not the URL.
    write_meta(&profile, &url, headful);
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

fn mouse_button_mask(button: &str) -> i64 {
    match button {
        "right" => 2,
        "middle" => 4,
        _ => 1,
    }
}

/// One full press at viewport coordinates. Frameworks bind on the real
/// press/release pair and on the hover that precedes it, so all three
/// events are dispatched instead of a synthetic `element.click()`.
async fn click_point(port: u16, x: f64, y: f64, button: &str) -> Result<(), String> {
    cdp(
        port,
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseMoved", "x": x, "y": y, "buttons": 0 }),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(25)).await;
    cdp(
        port,
        "Input.dispatchMouseEvent",
        json!({
            "type": "mousePressed",
            "x": x,
            "y": y,
            "button": button,
            "buttons": mouse_button_mask(button),
            "clickCount": 1
        }),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    cdp(
        port,
        "Input.dispatchMouseEvent",
        json!({
            "type": "mouseReleased",
            "x": x,
            "y": y,
            "button": button,
            "buttons": 0,
            "clickCount": 1
        }),
    )
    .await?;
    Ok(())
}

const FIND_ITEM_JS: &str = r#"(() => {
  const needle = __NEEDLE__;
  const exact = __EXACT__;
  const containerSelector = __CONTAINER__;
  const scope = containerSelector ? document.querySelector(containerSelector) : document;
  if (!scope) return { found: false, matches: 0 };
  const CANDS = 'a,button,li,[role=listitem],[role=option],[role=button],[role=link],[tabindex]';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const txt = (e) => norm(e.innerText || e.textContent || '');
  const hit = (t) => exact ? t === needle : t.toLowerCase().includes(needle.toLowerCase());
  const matches = [];
  for (const e of scope.querySelectorAll(CANDS)) {
    if (!visible(e)) continue;
    if (hit(txt(e))) matches.push(e);
  }
  const el = matches[__INDEX__];
  if (!el) return { found: false, matches: matches.length };
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const stable = (e) => {
    if (e.id) return '#' + CSS.escape(e.id);
    for (const a of ['data-testid', 'data-test-id', 'data-cy', 'aria-label', 'role', 'href']) {
      const v = e.getAttribute && e.getAttribute(a);
      if (v) return e.tagName.toLowerCase() + '[' + a + '="' + v + '"]';
    }
    return null;
  };
  return {
    found: true,
    matches: matches.length,
    text: txt(el).slice(0, 300),
    selector: stable(el),
    x: r.left + r.width / 2,
    y: r.top + r.height / 2
  };
})()"#;

const COMPOSER_FOCUS_JS: &str = r#"(() => {
  const sel = __SELECTOR__;
  const pick = (e) => {
    if (!e) return false;
    e.scrollIntoView({ block: 'center' });
    e.focus();
    if (e.isContentEditable) {
      const r = document.createRange();
      r.selectNodeContents(e);
      r.collapse(false);
      const s = getSelection();
      if (s) { s.removeAllRanges(); s.addRange(r); }
    } else if ('selectionStart' in e) {
      try { e.setSelectionRange(e.value.length, e.value.length); } catch (_e) {}
    }
    return true;
  };
  if (sel) return pick(document.querySelector(sel));
  const cands = Array.from(document.querySelectorAll('div[contenteditable="true"],textarea,[role="textbox"],input[type="text"]'));
  return pick(cands.find((e) => {
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  }));
})()"#;

#[tauri::command]
pub async fn browser_session_select(
    session_id: String,
    selector: String,
    value: String,
) -> Result<Value, String> {
    let port = port_of(&session_id).await?;
    let mut js = format!(
        "(()=>{{const e=document.querySelector({sel});if(!e)throw new Error('selector not found');",
        sel = quoted(&selector)
    );
    js.push_str("if(!(e instanceof HTMLSelectElement))throw new Error('selector is not a select element');");
    js.push_str(&format!("e.value={v};", v = quoted(&value)));
    js.push_str("e.dispatchEvent(new Event('input',{bubbles:true}));");
    js.push_str("e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()");
    let selected = eval(port, &js).await?;
    Ok(json!({
        "session_id": session_id,
        "selector": selector,
        "value": selected.as_str().unwrap_or(&value).to_string(),
        "status": "selected"
    }))
}

#[tauri::command]
pub async fn browser_session_click_at(
    session_id: String,
    x: f64,
    y: f64,
    button: Option<String>,
) -> Result<Value, String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("x and y must be finite numbers".to_string());
    }
    let button = button.unwrap_or_else(|| "left".to_string());
    let port = port_of(&session_id).await?;
    click_point(port, x, y, &button).await?;
    let focus_js = format!(
        "(() => {{ const el = document.elementFromPoint({x}, {y}); if (el && typeof el.focus === 'function') el.focus(); }})()"
    );
    let _ = eval(port, &focus_js).await;
    Ok(json!({ "session_id": session_id, "x": x, "y": y, "button": button, "clicked": true }))
}

#[tauri::command]
pub async fn browser_session_composer(
    session_id: String,
    text: String,
    selector: Option<String>,
    submit: Option<bool>,
) -> Result<Value, String> {
    if text.is_empty() {
        return Err("text is required".to_string());
    }
    let submit = submit.unwrap_or(false);
    let port = port_of(&session_id).await?;
    let js = COMPOSER_FOCUS_JS.replace(
        "__SELECTOR__",
        &match selector.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(sel) => quoted(sel),
            None => "null".to_string(),
        },
    );
    let focused = eval(port, &js).await?;
    if focused.as_bool() != Some(true) {
        return Err("no visible composer found; pass a selector".to_string());
    }
    cdp(port, "Input.insertText", json!({ "text": text })).await?;
    if submit {
        for kind in ["rawKeyDown", "keyUp"] {
            cdp(
                port,
                "Input.dispatchKeyEvent",
                json!({
                    "type": kind,
                    "key": "Enter",
                    "code": "Enter",
                    "text": "\r",
                    "windowsVirtualKeyCode": 13,
                    "nativeVirtualKeyCode": 13
                }),
            )
            .await?;
        }
    }
    Ok(json!({
        "session_id": session_id,
        "typed": text.chars().count(),
        "submitted": submit,
        "status": "composed"
    }))
}

#[tauri::command]
pub async fn browser_session_click_item(
    session_id: String,
    text: String,
    exact: Option<bool>,
    container_selector: Option<String>,
    index: Option<u32>,
    click: Option<bool>,
) -> Result<Value, String> {
    let needle = text.trim().to_string();
    if needle.is_empty() {
        return Err("text is required".to_string());
    }
    let click = click.unwrap_or(true);
    let index = index.unwrap_or(0);
    let port = port_of(&session_id).await?;
    let js = FIND_ITEM_JS
        .replace("__NEEDLE__", &quoted(&needle))
        .replace(
            "__EXACT__",
            if exact.unwrap_or(false) { "true" } else { "false" },
        )
        .replace(
            "__CONTAINER__",
            &match container_selector
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(sel) => quoted(sel),
                None => "null".to_string(),
            },
        )
        .replace("__INDEX__", &index.to_string());
    let found = eval(port, &js).await?;
    if found.get("found").and_then(Value::as_bool) != Some(true) {
        let matches = found.get("matches").and_then(Value::as_u64).unwrap_or(0);
        return Err(format!(
            "no visible item matching {needle:?} at index {index} ({matches} candidate(s) matched)"
        ));
    }
    let x = found.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = found.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    let mut result = json!({
        "session_id": session_id,
        "text": found.get("text").cloned().unwrap_or_else(|| json!("")),
        "selector": found.get("selector").cloned().unwrap_or(Value::Null),
        "x": x,
        "y": y,
        "matches": found.get("matches").cloned().unwrap_or_else(|| json!(0))
    });
    if click {
        click_point(port, x, y, "left").await?;
        result["clicked"] = json!(true);
    }
    Ok(result)
}

#[tauri::command]
pub async fn browser_session_eval(
    session_id: String,
    expression: String,
    await_promise: Option<bool>,
) -> Result<Value, String> {
    let expression = expression.trim().to_string();
    if expression.is_empty() {
        return Err("expression is required".to_string());
    }
    let port = port_of(&session_id).await?;
    let value = eval_ext(port, &expression, await_promise.unwrap_or(true)).await?;
    Ok(json!({ "session_id": session_id, "value": value }))
}

#[tauri::command]
pub async fn browser_session_cookies(
    session_id: String,
    action: Option<String>,
    cookies: Option<Value>,
    urls: Option<Vec<String>>,
) -> Result<Value, String> {
    let port = port_of(&session_id).await?;
    let action = action
        .unwrap_or_else(|| "get".to_string())
        .to_ascii_lowercase();
    match action.as_str() {
        "get" => {
            let mut params = serde_json::Map::new();
            if let Some(urls) = urls {
                params.insert("urls".to_string(), json!(urls));
            }
            let value = cdp(port, "Network.getCookies", Value::Object(params)).await?;
            let list = value
                .pointer("/result/cookies")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let count = list.as_array().map(|a| a.len()).unwrap_or(0);
            Ok(json!({ "session_id": session_id, "cookies": list, "count": count }))
        }
        "set" => {
            let list = cookies
                .and_then(|v| v.as_array().cloned())
                .ok_or_else(|| "action=set requires a cookies array".to_string())?;
            if list.is_empty() {
                return Err("cookies must not be empty".to_string());
            }
            for cookie in &list {
                let has_name = cookie.get("name").and_then(Value::as_str).is_some();
                let has_value = cookie.get("value").and_then(Value::as_str).is_some();
                if !has_name || !has_value {
                    return Err("each cookie needs a name and a value".to_string());
                }
                let has_domain = cookie.get("domain").and_then(Value::as_str).is_some();
                let has_url = cookie.get("url").and_then(Value::as_str).is_some();
                if !has_domain && !has_url {
                    return Err("each cookie needs a domain or a url".to_string());
                }
            }
            let count = list.len();
            cdp(port, "Network.setCookies", json!({ "cookies": list })).await?;
            Ok(json!({ "session_id": session_id, "set": count }))
        }
        "clear" => {
            cdp(port, "Network.clearBrowserCookies", json!({})).await?;
            Ok(json!({ "session_id": session_id, "cleared": true }))
        }
        other => Err(format!(
            "unknown action '{other}'; expected get, set, or clear"
        )),
    }
}

#[tauri::command]
pub async fn browser_session_wait(
    session_id: String,
    selector: String,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let port = port_of(&session_id).await?;
    let timeout = timeout_ms.unwrap_or(5_000).clamp(100, 30_000);
    let js = format!(
        "(()=>{{const e=document.querySelector({sel});if(!e)return false;const r=e.getBoundingClientRect();const st=getComputedStyle(e);return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none'}})()",
        sel = quoted(&selector)
    );
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < u128::from(timeout) {
        if eval(port, &js).await?.as_bool() == Some(true) {
            return Ok(json!({
                "session_id": session_id,
                "selector": selector,
                "visible": true,
                "elapsed_ms": started.elapsed().as_millis()
            }));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(json!({
        "session_id": session_id,
        "selector": selector,
        "visible": false,
        "timeout": true,
        "elapsed_ms": started.elapsed().as_millis()
    }))
}

#[tauri::command]
pub async fn browser_session_screenshot(session_id: String, path: String) -> Result<Value, String> {
    if !path.to_ascii_lowercase().ends_with(".png") {
        return Err("path must end with .png".to_string());
    }
    let target = guard_write(Path::new(&path))?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let port = port_of(&session_id).await?;
    let value = cdp(
        port,
        "Page.captureScreenshot",
        json!({ "format": "png", "captureBeyondViewport": true }),
    )
    .await?;
    let data = value
        .pointer("/result/data")
        .and_then(Value::as_str)
        .ok_or_else(|| "browser did not return screenshot data".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("invalid screenshot payload: {e}"))?;
    use base64::Engine as _;
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(json!({
        "session_id": session_id,
        "path": target.display().to_string(),
        "bytes": bytes.len()
    }))
}

/// Relaunch a saved profile after the process that owned it exited. The
/// profile directory is the identity, so the session id survives a restart;
/// the URL and headful flag come from the meta file written at create time.
#[tauri::command]
pub async fn browser_session_resume(session_id: String) -> Result<SessionInfo, String> {
    valid_id(&session_id)?;
    if let Some(existing) = live().lock().await.get(&session_id) {
        return Ok(existing.info.clone());
    }
    let profile = sessions_root()?.join(&session_id);
    if !profile.is_dir() {
        return Err(format!(
            "no saved profile for session '{session_id}' under {}",
            profile.display()
        ));
    }
    let (url, headful) = read_meta(&profile).unwrap_or_else(|| ("about:blank".to_string(), false));
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

fn meta_path(profile: &Path) -> PathBuf {
    profile.join("session-meta.json")
}

fn write_meta(profile: &Path, url: &str, headful: bool) {
    let _ = std::fs::write(
        meta_path(profile),
        json!({ "url": url, "headful": headful }).to_string(),
    );
}

fn read_meta(profile: &Path) -> Option<(String, bool)> {
    let raw = std::fs::read_to_string(meta_path(profile)).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let url = value.get("url").and_then(Value::as_str)?.to_string();
    let headful = value.get("headful").and_then(Value::as_bool).unwrap_or(false);
    Some((url, headful))
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
