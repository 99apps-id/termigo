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
use tauri::{
    AppHandle, Listener, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Size, State,
    WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
};

const VALUE_EVENT: &str = "termigo:browser-value";

/// WebView2 renders a SECOND webview (our agent browser window) permanently
/// blank on Windows when its additional browser arguments differ from the main
/// window's - tauri-apps/tauri#13092. wry applies occlusion / background-
/// throttling flags to the main webview, so a child created without them
/// mismatches and comes up white/black. Setting the flags at the WebView2
/// ENVIRONMENT level (this process-wide env var, read by the WebView2 loader)
/// makes every webview share the same args, so the child renders. Must run once
/// at startup, before any webview is created. Ported from TEDI's fix.
#[cfg(windows)]
pub fn apply_webview2_browser_args_env() {
    const ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required";
    // Edition 2021: set_var is safe. Called on the main thread at startup before
    // any webview (or other thread) exists.
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ARGS);
}

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
    /// Drop the stored extract value so a fresh `browser_extract` cannot return
    /// the previous page's text while the current page is still loading.
    fn clear_value(&self, instance: &str) {
        if let Ok(mut map) = self.0.entries.lock() {
            if let Some(e) = map.get_mut(instance) {
                e.last_value = None;
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
        log::info!("browser: reuse window '{instance}', navigate to {url}");
        let _ = w.set_focus();
        let _ = w.eval(format!(
            "window.location.href = {url:?};"
        ));
        return Ok(());
    }
    log::info!("browser: create window '{instance}' at {url}");
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let nav_url = parsed.clone();
    // Injected before page scripts on every navigation. It bridges the page back
    // to the host over the event channel (granted to `browser-*` windows for
    // remote URLs by capabilities/browser.json): console output is forwarded so
    // browser_console works, and a helper lets browser_extract read the rendered
    // DOM even on JS-heavy / strict-CSP sites (host-injected scripts bypass the
    // page CSP). The instance name is baked in so the host routes the value.
    let init = format!(
        r#"(function(){{
  var INST = {instance:?};
  function send(kind, value){{
    try {{
      if (window.__TAURI__ && window.__TAURI__.event) {{
        window.__TAURI__.event.emit('{VALUE_EVENT}', {{ instance: INST, kind: kind, value: String(value).slice(0, 200000) }});
      }}
    }} catch (e) {{}}
  }}
  window.__termigoExtract = function(){{ send('extract', document.body ? document.body.innerText : ''); }};
  try {{
    ['log','warn','error','info'].forEach(function(m){{
      var orig = console[m];
      console[m] = function(){{ try {{ send('console', Array.prototype.join.call(arguments, ' ')); }} catch (e) {{}} return orig.apply(console, arguments); }};
    }});
  }} catch (e) {{}}
}})();"#
    );
    let builder = WebviewWindowBuilder::new(
        app,
        label_for(instance),
        WebviewUrl::External(parsed),
    )
    .title("Termigo Browser")
    .initialization_script(&init)
    .inner_size(1000.0, 720.0)
    .min_inner_size(480.0, 320.0)
    .resizable(true);
    let w = builder.build().map_err(|e| {
        log::error!("browser: window build failed for '{instance}': {e}");
        e.to_string()
    })?;
    log::info!("browser: window '{instance}' built");
    // Force the navigation explicitly as well. On some WebView2 setups a child
    // window created with an External builder URL comes up blank until it is
    // navigated; calling navigate() here is the supported way and is harmless
    // when the initial load already worked.
    match w.navigate(nav_url) {
        Ok(()) => log::info!("browser: navigate() ok for '{instance}'"),
        Err(e) => log::error!("browser: navigate() failed for '{instance}': {e}"),
    }
    let _ = w.set_focus();
    // WebView2 on Windows paints a runtime-created child window BLACK until it
    // receives a resize. Nudge the size by a pixel once the webview has had a
    // moment to initialize, then restore it, which forces a repaint. Harmless
    // on other platforms.
    let wc = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(450));
        if let Ok(sz) = wc.inner_size() {
            let _ = wc.set_size(tauri::PhysicalSize::new(sz.width.saturating_add(1), sz.height));
            let _ = wc.set_size(sz);
        }
        let _ = wc.set_focus();
    });
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
    // Clear any value left from a previous page so a slow load cannot return
    // stale text as if it were the current page.
    state.clear_value(&instance);
    // Prefer the helper the initialization script installed (it shares one
    // send() path with the console hook); fall back to an inline emit if the
    // helper is not present yet (e.g. extract called before the first load).
    let js = format!(
        "(()=>{{try{{if(window.__termigoExtract){{window.__termigoExtract();return;}}const t=document.body?document.body.innerText:'';window.__TAURI__&&window.__TAURI__.event&&window.__TAURI__.event.emit('{VALUE_EVENT}',{{instance:{instance:?},kind:'extract',value:String(t).slice(0,200000)}});}}catch(e){{}}}})();"
    );
    w.eval(&js).map_err(|e| e.to_string())?;
    // The value arrives asynchronously via the event listener. Poll for it up to
    // a couple of seconds so a page that is still loading has time to answer,
    // instead of failing on the first 120ms tick.
    for _ in 0..25 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some(v) = state.entry(&instance).and_then(|e| e.last_value) {
            return Ok(v);
        }
    }
    // No text came back. This is a FINAL answer for this call, not a transient
    // error to retry: returning Ok stops an agent from looping on extract. The
    // message steers it to the fetch tool, which reads page content over HTTP
    // and does not depend on the webview's scripting bridge.
    Ok("(no readable text returned from the page. It may still be loading, may block injected scripts, or may render entirely in a way this bridge cannot read. Do NOT retry browser_extract; use the `fetch` tool to read the page's HTTP content, or browser_screenshot if a visual is needed.)".to_string())
}

#[tauri::command]
pub fn browser_console(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
) -> Result<String, String> {
    // Console output is captured live by the window's initialization script,
    // which forwards each console.* call over the value channel. This just
    // returns what has accumulated for the instance.
    let _ = webview(&app, &instance).ok_or("browser instance not open")?;
    let e = state.entry(&instance).ok_or("browser instance not open")?;
    if e.console.is_empty() {
        return Ok("(no console output captured for this page)".to_string());
    }
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

// ──────────────────────────────────────────────────────────────────────────
// Embedded browser: a child webview docked INSIDE the main window (via the
// unstable `Window::add_child` API), instead of a separate floating window.
// The child shares the main window's WebView2 environment, which is what makes
// it render reliably where the floating window came up blank (tauri#13092).
// The frontend measures its pane rectangle and pushes physical-pixel bounds
// here every frame; a hidden or zero-area request hides the webview.
// ──────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn embed_label(instance: &str) -> String {
    format!("browser-embed-{instance}")
}

fn embed_init_script(instance: &str) -> String {
    format!(
        r#"(function(){{
  var INST = {instance:?};
  function send(kind, value){{
    try {{ if (window.__TAURI__ && window.__TAURI__.event) {{ window.__TAURI__.event.emit('{VALUE_EVENT}', {{ instance: INST, kind: kind, value: String(value).slice(0, 200000) }}); }} }} catch (e) {{}}
  }}
  window.__termigoExtract = function(){{ send('extract', document.body ? document.body.innerText : ''); }};
  try {{ ['log','warn','error','info'].forEach(function(m){{ var orig = console[m]; console[m] = function(){{ try {{ send('console', Array.prototype.join.call(arguments, ' ')); }} catch (e) {{}} return orig.apply(console, arguments); }}; }}); }} catch (e) {{}}
  function reportUrl(){{ send('url', location.href); }}
  try {{ ['load','popstate','hashchange'].forEach(function(ev){{ window.addEventListener(ev, reportUrl); }}); }} catch (e) {{}}
  try {{ ['pushState','replaceState'].forEach(function(m){{ var o = history[m]; history[m] = function(){{ var r = o.apply(history, arguments); try {{ reportUrl(); }} catch (e) {{}} return r; }}; }}); }} catch (e) {{}}
  try {{ setTimeout(reportUrl, 0); }} catch (e) {{}}
}})();"#
    )
}

/// Create, reposition, show or hide the embedded browser webview for `instance`.
/// Bounds are physical pixels relative to the main window. A not-visible or
/// zero-area request hides an existing webview.
#[tauri::command]
pub async fn browser_embed_update(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, BrowserState>,
    instance: String,
    url: String,
    bounds: EmbedBounds,
    visible: bool,
) -> Result<(), String> {
    if instance.is_empty() {
        return Err("browser instance name cannot be empty".into());
    }
    if !url.is_empty() {
        if let Some(reason) = unsafe_url(&url) {
            return Err(format!("Refused: {reason}"));
        }
    }
    let label = embed_label(&instance);
    log::info!(
        "browser_embed_update: instance={instance} visible={visible} bounds=({:.0},{:.0},{:.0},{:.0}) url_len={} exists={}",
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        url.len(),
        app.get_webview(&label).is_some(),
    );

    if !visible || bounds.width < 1.0 || bounds.height < 1.0 {
        if let Some(wv) = app.get_webview(&label) {
            wv.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let position = PhysicalPosition::new(bounds.x.round() as i32, bounds.y.round() as i32);
    let size = PhysicalSize::new(
        (bounds.width.round() as i32).max(1) as u32,
        (bounds.height.round() as i32).max(1) as u32,
    );

    if let Some(wv) = app.get_webview(&label) {
        wv.set_bounds(Rect {
            position: Position::Physical(position),
            size: Size::Physical(size),
        })
        .map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // First visible call: create the child webview at the pane's rectangle.
    if url.is_empty() {
        return Ok(());
    }
    let parsed = reqwest::Url::parse(&url).map_err(|e| {
        log::error!("browser_embed_update: bad url '{url}': {e}");
        e.to_string()
    })?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(&embed_init_script(&instance))
        // Keep the pane rendering even when occluded / in the background - the
        // same flag TEDI relies on so a docked webview does not suspend.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    window
        .add_child(builder, Position::Physical(position), Size::Physical(size))
        .map_err(|e| {
            log::error!("browser_embed_update: add_child failed for '{instance}': {e}");
            e.to_string()
        })?;
    log::info!(
        "browser: embedded webview '{instance}' created at {url} at ({},{}) {}x{}",
        position.x,
        position.y,
        size.width,
        size.height
    );
    state.record(&instance, Some(url));
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_navigate(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
    url: String,
) -> Result<(), String> {
    if let Some(reason) = unsafe_url(&url) {
        return Err(format!("Refused: {reason}"));
    }
    let wv = app
        .get_webview(&embed_label(&instance))
        .ok_or("embedded browser not open")?;
    wv.eval(format!("window.location.href = {url:?};"))
        .map_err(|e| e.to_string())?;
    state.record(&instance, Some(url));
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_read(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
) -> Result<String, String> {
    let wv = app
        .get_webview(&embed_label(&instance))
        .ok_or("embedded browser not open")?;
    state.clear_value(&instance);
    let js = format!(
        "(()=>{{try{{if(window.__termigoExtract){{window.__termigoExtract();return;}}const t=document.body?document.body.innerText:'';window.__TAURI__&&window.__TAURI__.event&&window.__TAURI__.event.emit('{VALUE_EVENT}',{{instance:{instance:?},kind:'extract',value:String(t).slice(0,200000)}});}}catch(e){{}}}})();"
    );
    wv.eval(&js).map_err(|e| e.to_string())?;
    for _ in 0..25 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some(v) = state.entry(&instance).and_then(|e| e.last_value) {
            return Ok(v);
        }
    }
    Ok("(no readable text returned from the page. It may still be loading.)".to_string())
}

#[tauri::command]
pub async fn browser_embed_eval(
    app: AppHandle,
    instance: String,
    js: String,
) -> Result<(), String> {
    let wv = app
        .get_webview(&embed_label(&instance))
        .ok_or("embedded browser not open")?;
    wv.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_embed_close(
    app: AppHandle,
    state: State<'_, BrowserState>,
    instance: String,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&embed_label(&instance)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    state.remove(&instance);
    Ok(())
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
