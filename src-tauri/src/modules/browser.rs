//! AI Browser Control — native webview instances the agent can drive.
//!
//! The agent exposes tools that open a dedicated Tauri webview window per
//! "browser instance" and drive it (navigate / back / forward / reload /
//! extract / click / type / screenshot). The frontend guards URLs through
//! `browserGuard.ts`; this module re-applies the same host policy on the Rust
//! side so a bypass in one layer cannot reach the network stack.
//!
//! Value-returning reads (extract, console) flow back through a Tauri event:
//! the injected script emits `termigo:browser-value` with `{ instance, kind,
//! value }`, and a listener registered by `browser_start` stores the latest
//! value per instance. This keeps the injected JS free of return-value IPC and
//! works even for pages that do not expose Tauri's sync invoke path.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Listener, Manager, State, WebviewUrl, WebviewWindowBuilder};

const VALUE_EVENT: &str = "termigo:browser-value";

/// Normalize an IPv4 host to dotted-quad (decimal / hex / octal forms), mirroring
/// the frontend guard so a numeric-IP trick is caught identically on both sides.
pub fn normalize_ipv4(host: &str) -> Option<String> {
    let h = host.to_ascii_lowercase();
    let is_decimal = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let is_hex = |s: &str| {
        if let Some(rest) = s.strip_prefix("0x") {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_hexdigit())
        } else {
            false
        }
    };
    let is_octal = |s: &str| {
        s.len() > 1
            && s.starts_with('0')
            && s.bytes().all(|b| (b'0'..=b'7').contains(&b))
    };
    if h.contains('.') {
        let parts: Vec<&str> = h.split('.').collect();
        if parts.len() != 4 {
            return None;
        }
        let mut out = Vec::with_capacity(4);
        for p in parts {
            if !is_decimal(p) {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if n > 255 {
                return None;
            }
            out.push(n.to_string());
        }
        return Some(out.join("."));
    }
    if is_decimal(&h) || is_hex(&h) || is_octal(&h) {
        let (base, digits) = if is_hex(&h) {
            (16u32, &h[2..])
        } else if is_octal(&h) {
            (8u32, &h[1..])
        } else {
            (10u32, h.as_str())
        };
        let n = u32::from_str_radix(digits, base).ok()?;
        return Some([
            (n >> 24) as u8,
            (n >> 16) as u8,
            (n >> 8) as u8,
            n as u8,
        ]
        .map(|b| b.to_string())
        .join("."));
    }
    None
}

/// Return a reason the URL is unsafe to drive, or None when safe. Kept in sync
/// with the frontend `unsafeBrowserUrl` policy so the network path is always
/// guarded on the backend.
pub fn unsafe_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !(parsed.scheme() == "http" || parsed.scheme() == "https") {
        return Some("only http/https URLs are allowed".to_string());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let is_metadata = host == "169.254.169.254"
        || host == "metadata.google.internal"
        || host.ends_with(".metadata.google.internal")
        || host.ends_with(".compute.internal")
        || host == "instance-data"
        || host.ends_with(".internal");
    if is_metadata {
        return Some("cloud-metadata endpoints are blocked".to_string());
    }
    if let Some(ip) = normalize_ipv4(&host) {
        if ip.starts_with("127.") {
            return Some("loopback addresses are blocked".to_string());
        }
        if ip.starts_with("169.254.") {
            return Some("link-local addresses are blocked".to_string());
        }
    }
    // Block non-loopback IPv6 (fe80::, fd00::, ...); only ::1 is allowed.
    if host.contains(':') && host != "[::1]" && host != "::1" {
        return Some("non-loopback IPv6 addresses are blocked".to_string());
    }
    None
}

#[derive(Clone)]
struct BrowserEntry {
    url: Option<String>,
    last_value: Option<String>,
    console: Vec<String>,
}

#[derive(Default)]
struct BrowserCore {
    entries: Mutex<HashMap<String, BrowserEntry>>,
}

#[derive(Clone, Default)]
pub struct BrowserState(Arc<BrowserCore>);

impl BrowserState {
    fn entry(&self, instance: &str) -> Option<BrowserEntry> {
        self.0.entries.lock().ok()?.get(instance).cloned()
    }
    fn record(&self, instance: &str, url: Option<String>) {
        if let Ok(mut map) = self.0.entries.lock() {
            let e = map.entry(instance.to_string()).or_insert_with(|| BrowserEntry {
                url: None,
                last_value: None,
                console: Vec::new(),
            });
            if url.is_some() {
                e.url = url;
            }
        }
    }
    fn record_value(&self, instance: &str, kind: &str, value: &str) {
        if let Ok(mut map) = self.0.entries.lock() {
            let e = map.entry(instance.to_string()).or_insert_with(|| BrowserEntry {
                url: None,
                last_value: None,
                console: Vec::new(),
            });
            if kind == "console" {
                e.console.push(value.to_string());
                if e.console.len() > 500 {
                    let drain = e.console.len() - 500;
                    e.console.drain(..drain);
                }
            } else {
                e.last_value = Some(value.to_string());
            }
        }
    }
    fn list(&self) -> Vec<String> {
        if let Ok(map) = self.0.entries.lock() {
            return map.keys().cloned().collect();
        }
        Vec::new()
    }
    fn remove(&self, instance: &str) {
        if let Ok(mut map) = self.0.entries.lock() {
            map.remove(instance);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub instance: String,
    pub url: Option<String>,
}

fn label_for(instance: &str) -> String {
    format!("browser-{instance}")
}

fn webview(app: &AppHandle, instance: &str) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(&label_for(instance))
}

fn ensure_window(app: &AppHandle, instance: &str, url: &str) -> Result<(), String> {
    if let Some(w) = webview(app, instance) {
        let _ = w.set_focus();
        let _ = w.eval(format!(
            "window.location.href = {url:?};"
        ));
        return Ok(());
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let builder = WebviewWindowBuilder::new(
        app,
        label_for(instance),
        WebviewUrl::External(parsed),
    )
    .title("Termigo Browser")
    .inner_size(1000.0, 720.0)
    .min_inner_size(480.0, 320.0)
    .resizable(true);
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
    url: String,
) -> Result<BrowserSnapshot, String> {
    if instance.is_empty() {
        return Err("browser instance name cannot be empty".into());
    }
    if let Some(reason) = unsafe_url(&url) {
        return Err(format!("Refused: {reason}"));
    }
    ensure_window(&app, &instance, &url)?;
    state.record(&instance, Some(url));
    Ok(BrowserSnapshot {
        instance: instance.clone(),
        url: state.entry(&instance).and_then(|e| e.url),
    })
}

#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
    url: String,
) -> Result<BrowserSnapshot, String> {
    if let Some(reason) = unsafe_url(&url) {
        return Err(format!("Refused: {reason}"));
    }
    let w = webview(&app, &instance).ok_or("browser instance not open")?;
    w.eval(format!("window.location.href = {url:?};"))
        .map_err(|e| e.to_string())?;
    state.record(&instance, Some(url.clone()));
    Ok(BrowserSnapshot {
        instance,
        url: Some(url),
    })
}

#[tauri::command]
pub fn browser_back(app: AppHandle, instance: String) -> Result<(), String> {
    let w = webview(&app, &instance).ok_or("browser instance not open")?;
    w.eval("history.back();").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, instance: String) -> Result<(), String> {
    let w = webview(&app, &instance).ok_or("browser instance not open")?;
    w.eval("history.forward();").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, instance: String) -> Result<(), String> {
    let w = webview(&app, &instance).ok_or("browser instance not open")?;
    w.eval("location.reload();").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_wait(instance: String, ms: u64) -> String {
    // Wait is implemented in the frontend; this command exists so the tool
    // surface has a native anchor and can report the instance at a glance.
    let _ = instance;
    format!("waited {ms}ms")
}

#[tauri::command]
pub fn browser_eval(
    app: AppHandle,
    instance: String,
    js: String,
) -> Result<(), String> {
    let w = webview(&app, &instance).ok_or("browser instance not open")?;
    w.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_extract(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
) -> Result<String, String> {
    let w = webview(&app, &instance).ok_or("browser instance not open")?;
    // Emit the DOM text back through the value channel. The instance label is
    // embedded so the listener can route it to the right entry.
    let js = format!(
        "(()=>{{const t=document.body?document.body.innerText:'';window.__TAURI__&&window.__TAURI__.event&&window.__TAURI__.event.emit('{VALUE_EVENT}',{{instance:{instance:?},kind:'extract',value:t}});}})();"
    );
    w.eval(&js).map_err(|e| e.to_string())?;
    // The value arrives via the event listener asynchronously; sleep briefly so
    // the tool returns the freshest value without racing the webview.
    std::thread::sleep(std::time::Duration::from_millis(120));
    state
        .entry(&instance)
        .and_then(|e| e.last_value)
        .ok_or_else(|| "no extract value yet; page may not have loaded".to_string())
}

#[tauri::command]
pub fn browser_console(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
) -> Result<String, String> {
    let w = webview(&app, &instance).ok_or("browser instance not open")?;
    let js = format!(
        "window.__TAURI__&&window.__TAURI__.event&&window.__TAURI__.event.emit('{VALUE_EVENT}',{{instance:{instance:?},kind:'console',value:'console requested'}});"
    );
    w.eval(&js).map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(120));
    let e = state.entry(&instance).ok_or("browser instance not open")?;
    Ok(e.console.join("\n"))
}

#[tauri::command]
pub fn browser_screenshot(_app: AppHandle, _instance: String) -> Result<String, String> {
    // Native webview screenshots are platform-specific and not exposed by Tauri
    // 2 cross-platform; return an explicit signal so the tool can tell the
    // agent to ask the user instead of silently failing.
    Err("webview screenshot is not supported on this platform yet".into())
}

#[tauri::command]
pub fn browser_url(
    _app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
) -> Result<String, String> {
    state
        .entry(&instance)
        .and_then(|e| e.url)
        .ok_or_else(|| "browser instance not open".to_string())
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
) -> Result<(), String> {
    if let Some(w) = webview(&app, &instance) {
        w.close().map_err(|e| e.to_string())?;
    }
    state.remove(&instance);
    Ok(())
}

#[tauri::command]
pub fn browser_list(state: State<'_, BrowserState>) -> Vec<String> {
    state.list()
}

/// Register the value-return listener. Called once from `lib.rs` setup so the
/// read commands can collect extract / console payloads emitted by injected JS.
pub fn browser_start(app: &AppHandle, state: &BrowserState) {
    let state = state.clone();
    let _ = app.listen(VALUE_EVENT, move |event| {
        if let Ok(payload) = serde_json::from_str::<ValuePayload>(event.payload()) {
            state.record_value(&payload.instance, &payload.kind, &payload.value);
        }
    });
}

#[derive(Deserialize)]
struct ValuePayload {
    instance: String,
    kind: String,
    value: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_decimal_hex_and_octal_ipv4() {
        assert_eq!(normalize_ipv4("127.0.0.1"), Some("127.0.0.1".into()));
        assert_eq!(normalize_ipv4("2130706433"), Some("127.0.0.1".into()));
        assert_eq!(normalize_ipv4("0x7f000001"), Some("127.0.0.1".into()));
        assert_eq!(normalize_ipv4("017700000001"), Some("127.0.0.1".into()));
        assert_eq!(normalize_ipv4("999.0.0.1"), None);
    }

    #[test]
    fn refuses_metadata_loopback_link_local_and_ipv6() {
        assert!(unsafe_url("http://169.254.169.254").is_some());
        assert!(unsafe_url("http://metadata.google.internal").is_some());
        assert!(unsafe_url("http://127.0.0.1").is_some());
        assert!(unsafe_url("http://2130706433").is_some());
        assert!(unsafe_url("http://[fe80::1]/").is_some());
        assert!(unsafe_url("file:///etc/passwd").is_some());
        // Normal https sites are allowed by the raw guard.
        assert_eq!(unsafe_url("https://example.com"), None);
    }
}
