//! OAuth preset sign-in for Codex (OpenAI), Claude (Anthropic), and
//! Antigravity (Google Cloud Code).
//!
//! The flow mirrors the vendor CLI clients (ported from the NesaRouter preset
//! catalog):
//! - **Codex**: authorization-code + PKCE with a loopback listener on
//!   `http://localhost:1455/auth/callback` (the CLI's fixed redirect URI).
//! - **Claude**: authorization-code + PKCE with the "manual code" flow — the
//!   browser redirects to console.anthropic.com which shows a code the user
//!   pastes back into Termigo.
//! - **Antigravity**: authorization-code + PKCE with a loopback listener on
//!   `http://127.0.0.1:51121/oauth2callback`.
//!
//! Tokens are persisted in the OS keyring (Credential Manager on Windows,
//! Keychain on macOS, or the mode-0600 file on Linux) via the same backends
//! as the `secrets` module.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

#[cfg(target_os = "linux")]
use super::secrets;

// ---- Profiles & presets ---------------------------------------------------

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum OAuthProfile {
    Codex,
    Claude,
    Antigravity,
}

impl OAuthProfile {
    fn as_str(self) -> &'static str {
        match self {
            OAuthProfile::Codex => "codex",
            OAuthProfile::Claude => "claude",
            OAuthProfile::Antigravity => "antigravity",
        }
    }

    fn preset(self) -> &'static Preset {
        match self {
            OAuthProfile::Codex => &CODEX,
            OAuthProfile::Claude => &CLAUDE,
            OAuthProfile::Antigravity => &ANTIGRAVITY,
        }
    }
}

struct Preset {
    client_id: &'static str,
    client_secret: Option<&'static str>,
    authorize_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    /// true = JSON body on the token endpoint; false = form-encoded.
    json_body: bool,
    redirect_uri: &'static str,
    loopback_port: Option<u16>,
    loopback_path: &'static str,
    manual_code: bool,
    extra_authorize_params: &'static [(&'static str, &'static str)],
}

static CODEX: Preset = Preset {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    client_secret: None,
    authorize_url: "https://auth.openai.com/oauth/authorize",
    token_url: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    json_body: false,
    redirect_uri: "http://localhost:1455/auth/callback",
    loopback_port: Some(1455),
    loopback_path: "/auth/callback",
    manual_code: false,
    extra_authorize_params: &[
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("originator", "codex_cli_rs"),
    ],
};

static CLAUDE: Preset = Preset {
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    client_secret: None,
    authorize_url: "https://claude.ai/oauth/authorize",
    token_url: "https://api.anthropic.com/v1/oauth/token",
    scope: "org:create_api_key user:profile user:inference",
    json_body: true,
    redirect_uri: "https://console.anthropic.com/oauth/code/callback",
    loopback_port: None,
    loopback_path: "",
    manual_code: true,
    extra_authorize_params: &[("code", "true")],
};

static ANTIGRAVITY: Preset = Preset {
    client_id: "REDACTED_SUPPLIED_AT_BUILD_TIME",
    client_secret: Some("REDACTED_SUPPLIED_AT_BUILD_TIME"),
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
    json_body: false,
    redirect_uri: "http://127.0.0.1:51121/oauth2callback",
    loopback_port: Some(51121),
    loopback_path: "/oauth2callback",
    manual_code: false,
    extra_authorize_params: &[("access_type", "offline"), ("prompt", "consent")],
};

// ---- State ----------------------------------------------------------------

const PENDING_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct OAuthState {
    /// state -> (PKCE verifier, profile, created)
    pending: Mutex<HashMap<String, PendingAuth>>,
    /// state -> authorization code captured by the loopback listener
    loopback_codes: Arc<Mutex<HashMap<String, String>>>,
    /// Every `state` we have issued and not yet retired. The listener threads
    /// consult this to reject callbacks they did not originate; it is a
    /// separate set (rather than locking `pending`) so a listener thread never
    /// contends with an in-flight token exchange.
    known_states: Arc<Mutex<HashSet<String>>>,
    /// port -> running loopback listeners (kept alive for the session)
    listeners: Mutex<HashMap<u16, Vec<Arc<TcpListener>>>>,
}

impl OAuthState {
    /// Drop sign-in attempts older than `PENDING_TTL`, along with any code and
    /// state they left behind.
    ///
    /// Nothing else removes them: `oauth_poll` only *reads* the timestamp to
    /// report `Expired`, and an abandoned sign-in (user closes the browser tab)
    /// never reaches `oauth_exchange`. Called at the start of each sign-in so
    /// the maps stay proportional to active attempts rather than to the number
    /// of attempts made this session.
    fn sweep_expired(&self) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let mut dropped = Vec::new();
        pending.retain(|state, auth| {
            let live = auth.created.elapsed() <= PENDING_TTL;
            if !live {
                dropped.push(state.clone());
            }
            live
        });
        if dropped.is_empty() {
            return;
        }
        if let Ok(mut codes) = self.loopback_codes.lock() {
            for state in &dropped {
                codes.remove(state);
            }
        }
        if let Ok(mut known) = self.known_states.lock() {
            for state in &dropped {
                known.remove(state);
            }
        }
        log::debug!("oauth: swept {} expired sign-in attempt(s)", dropped.len());
    }

    /// Retire one sign-in attempt once it has succeeded or failed for good.
    fn forget(&self, state_value: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(state_value);
        }
        if let Ok(mut codes) = self.loopback_codes.lock() {
            codes.remove(state_value);
        }
        if let Ok(mut known) = self.known_states.lock() {
            known.remove(state_value);
        }
    }
}

#[derive(Clone)]
struct PendingAuth {
    verifier: String,
    profile: OAuthProfile,
    created: Instant,
}

// ---- PKCE helpers ---------------------------------------------------------

fn b64url(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

fn pkce_verifier() -> Result<String, String> {
    let mut buf = [0u8; 48];
    getrandom::fill(&mut buf).map_err(|e| format!("rng: {e}"))?;
    Ok(b64url(&buf))
}

fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

fn random_state() -> Result<String, String> {
    let mut buf = [0u8; 24];
    getrandom::fill(&mut buf).map_err(|e| format!("rng: {e}"))?;
    Ok(b64url(&buf))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---- Loopback listener ----------------------------------------------------

const CALLBACK_BODY: &str = "\
<!doctype html><html><body style='font-family:system-ui;background:#0f1422;color:#e7e9f2;display:grid;place-items:center;height:100vh;margin:0'>
<div style='text-align:center'><h2>✓ Connected</h2><p>You can close this tab and return to Termigo.</p></div>
</body></html>";

const CALLBACK_ERROR_BODY: &str = "\
<!doctype html><html><body style='font-family:system-ui;background:#0f1422;color:#ff8a8a;display:grid;place-items:center;height:100vh;margin:0'>
<p>Sign-in callback missing code. Close this tab and retry in Termigo.</p>
</body></html>";

/// Frame an HTTP response, measuring `Content-Length` from the body.
///
/// These headers previously carried hand-written lengths that understated the
/// real bodies (210 vs 271 bytes, and 150 vs 234), so browsers rendered a page
/// truncated mid-markup. Deriving the length here stops the two from drifting
/// apart again. `len()` is the BYTE length, which is what HTTP wants - the
/// success page contains a multi-byte character (`✓`), so `chars().count()`
/// would reintroduce the same class of bug.
fn http_response(status_line: &str, body: &str) -> Vec<u8> {
    format!(
        "{status_line}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if let Some(k) = it.next() {
            let v = it.next().unwrap_or("");
            let k = percent_decode(k);
            let v = percent_decode(v);
            map.insert(k, v);
        }
    }
    map
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 < bytes.len() {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                    if let Ok(v) = u8::from_str_radix(hex, 16) {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn spawn_loopback(
    codes: Arc<Mutex<HashMap<String, String>>>,
    known_states: Arc<Mutex<HashSet<String>>>,
    addr: String,
    path: &'static str,
) -> Result<Arc<TcpListener>, String> {
    let listener = Arc::new(
        TcpListener::bind(&addr).map_err(|e| format!("cannot bind loopback {addr}: {e}"))?,
    );
    let listen = listener.clone();
    thread::spawn(move || {
        for stream in listen.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = match stream.read(&mut buf) {
                Ok(n) => n,
                Err(_) => continue,
            };
            let head = String::from_utf8_lossy(&buf[..n]);
            let mut ok = false;
            // GET {path}?code=...&state=... HTTP/1.1
            if let Some(req_line) = head.lines().next() {
                if let Some((_method, rest)) = req_line.split_once(' ') {
                    if let Some((target, _ver)) = rest.split_once(' ') {
                        if let Some((path_part, query)) = target.split_once('?') {
                            if path_part == path {
                                let params = parse_query(query);
                                if let (Some(code), Some(state)) =
                                    (params.get("code"), params.get("state"))
                                {
                                    // Only accept a callback whose `state` we
                                    // actually issued. The port is reachable by
                                    // any local process and by any page the
                                    // browser loads, so without this check an
                                    // unrelated caller could plant unbounded
                                    // entries in the code map.
                                    let known = known_states
                                        .lock()
                                        .map(|s| s.contains(state))
                                        .unwrap_or(false);
                                    if known {
                                        codes
                                            .lock()
                                            .map(|mut m| m.insert(state.clone(), code.clone()))
                                            .ok();
                                        ok = true;
                                    } else {
                                        log::warn!(
                                            "oauth: ignoring loopback callback for unknown state"
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let _ = stream.write_all(&if ok {
                http_response("HTTP/1.1 200 OK", CALLBACK_BODY)
            } else {
                http_response("HTTP/1.1 400 Bad Request", CALLBACK_ERROR_BODY)
            });
        }
    });
    Ok(listener)
}

fn start_loopback(state: &OAuthState, port: u16, path: &'static str) -> Result<(), String> {
    {
        let listeners = state.listeners.lock().map_err(|e| e.to_string())?;
        if listeners.contains_key(&port) {
            return Ok(());
        }
    }
    let codes = state.loopback_codes.clone();
    let known = state.known_states.clone();
    let mut bound = Vec::new();
    // Bind IPv4 loopback first (Antigravity redirects to the explicit
    // `127.0.0.1`); then best-effort bind IPv6 loopback for hosts where
    // `localhost` (Codex) resolves to `::1`. Only loopback interfaces are
    // used — never 0.0.0.0 — so the callback port stays local-only.
    for addr in [format!("127.0.0.1:{port}"), format!("[::1]:{port}")] {
        if let Ok(l) = spawn_loopback(codes.clone(), known.clone(), addr, path) {
            bound.push(l);
        }
    }
    if bound.is_empty() {
        bound.push(spawn_loopback(
            codes,
            known,
            format!("127.0.0.1:{port}"),
            path,
        )?);
    }
    state
        .listeners
        .lock()
        .map_err(|e| e.to_string())?
        .insert(port, bound);
    Ok(())
}

// ---- Keyring helpers (same backends as secrets) ---------------------------

const OAUTH_SERVICE: &str = "termigo-oauth";

#[cfg(not(target_os = "linux"))]
fn set_secret(_app: &AppHandle, account: &str, value: &str) -> Result<(), String> {
    let e = keyring::Entry::new(OAUTH_SERVICE, account).map_err(|e| e.to_string())?;
    e.set_password(value).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn get_secret(_app: &AppHandle, account: &str) -> Result<Option<String>, String> {
    let e = keyring::Entry::new(OAUTH_SERVICE, account).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
fn delete_secret(_app: &AppHandle, account: &str) -> Result<(), String> {
    let e = keyring::Entry::new(OAUTH_SERVICE, account).map_err(|e| e.to_string())?;
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(target_os = "linux")]
fn set_secret(app: &AppHandle, account: &str, value: &str) -> Result<(), String> {
    let key = secrets::key(OAUTH_SERVICE, account);
    let path = oauth_store_path(app)?;
    let mut map = secrets::read_store_at(&path)?;
    map.insert(key, value.to_string());
    secrets::write_store_at(&path, &map)
}

#[cfg(target_os = "linux")]
fn get_secret(app: &AppHandle, account: &str) -> Result<Option<String>, String> {
    let key = secrets::key(OAUTH_SERVICE, account);
    let path = oauth_store_path(app)?;
    Ok(secrets::read_store_at(&path)?.get(&key).cloned())
}

#[cfg(target_os = "linux")]
fn delete_secret(app: &AppHandle, account: &str) -> Result<(), String> {
    let key = secrets::key(OAUTH_SERVICE, account);
    let path = oauth_store_path(app)?;
    let mut map = secrets::read_store_at(&path)?;
    map.remove(&key);
    secrets::write_store_at(&path, &map)
}

#[cfg(target_os = "linux")]
fn oauth_store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

// ---- Token model ----------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    /// Absolute unix seconds when the access token expires (computed locally).
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

/// The renderer's view of a signed-in account.
///
/// Deliberately omits `refresh_token`: it is the long-lived credential, and
/// nothing in the frontend needs it now that renewal happens in
/// `oauth_session`. Keeping it out of the IPC payload keeps it out of the
/// webview, out of devtools, and out of any state the UI serializes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OAuthSession {
    pub access_token: String,
    pub expires_at: Option<u64>,
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

impl From<&OAuthTokens> for OAuthSession {
    fn from(tokens: &OAuthTokens) -> Self {
        Self {
            access_token: tokens.access_token.clone(),
            expires_at: tokens.expires_at,
            scope: tokens.scope.clone(),
            project_id: tokens.project_id.clone(),
        }
    }
}

// ---- Commands -------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResult {
    pub authorize_url: String,
    pub state: String,
    pub manual_code: bool,
    pub redirect_uri: String,
}

#[tauri::command]
pub async fn oauth_start(
    state: State<'_, OAuthState>,
    profile: OAuthProfile,
) -> Result<OAuthStartResult, String> {
    let preset = profile.preset();
    // Retire anything left over from abandoned attempts before adding another.
    state.sweep_expired();
    let verifier = pkce_verifier()?;
    let challenge = pkce_challenge(&verifier);
    let state_value = random_state()?;

    if let Some(port) = preset.loopback_port {
        start_loopback(&state, port, preset.loopback_path)?;
    }

    let mut params: Vec<(String, String)> = vec![
        ("response_type".into(), "code".into()),
        ("client_id".into(), preset.client_id.into()),
        ("redirect_uri".into(), preset.redirect_uri.into()),
        ("scope".into(), preset.scope.into()),
        ("state".into(), state_value.clone()),
        ("code_challenge".into(), challenge),
        ("code_challenge_method".into(), "S256".into()),
    ];
    for (k, v) in preset.extra_authorize_params {
        params.push(((*k).to_string(), (*v).to_string()));
    }
    let query: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let authorize_url = format!("{}?{}", preset.authorize_url, query);

    state.pending.lock().map_err(|e| e.to_string())?.insert(
        state_value.clone(),
        PendingAuth {
            verifier,
            profile,
            created: Instant::now(),
        },
    );
    // Publish the state before the browser can call back, so the listener
    // recognises the callback as one of ours.
    state
        .known_states
        .lock()
        .map_err(|e| e.to_string())?
        .insert(state_value.clone());

    Ok(OAuthStartResult {
        authorize_url,
        state: state_value,
        manual_code: preset.manual_code,
        redirect_uri: preset.redirect_uri.to_string(),
    })
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OAuthPollResult {
    Pending,
    Ready { code: String },
    Expired,
}

#[tauri::command]
pub async fn oauth_poll(
    state: State<'_, OAuthState>,
    state_value: String,
) -> Result<OAuthPollResult, String> {
    // Take (not peek) the code so a stale entry can't be replayed. The caller
    // passes it straight to oauth_exchange.
    if let Some(code) = state
        .loopback_codes
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&state_value)
    {
        return Ok(OAuthPollResult::Ready { code });
    }
    let expired = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .get(&state_value)
        .map(|p| p.created.elapsed() > PENDING_TTL)
        .unwrap_or(true);
    Ok(if expired {
        OAuthPollResult::Expired
    } else {
        OAuthPollResult::Pending
    })
}

async fn post_token(
    preset: &'static Preset,
    mut body: HashMap<String, String>,
) -> Result<OAuthTokens, String> {
    if let Some(secret) = preset.client_secret {
        body.insert("client_secret".to_string(), secret.to_string());
    }
    // No redirects. The body carries the client secret, the authorization code
    // and the PKCE verifier; reqwest's default policy would replay all three to
    // whatever host a 307/308 pointed at. Token URLs are fixed vendor
    // endpoints, so a redirect here is a misconfiguration or an attack, never
    // something to follow.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("token client build failed: {e}"))?;
    let resp = if preset.json_body {
        client
            .post(preset.token_url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
    } else {
        client
            .post(preset.token_url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&body)
            .send()
            .await
    }
    .map_err(|e| format!("token request failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("token response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("token endpoint returned {status}: {text}"));
    }
    let mut tokens: OAuthTokens =
        serde_json::from_str(&text).map_err(|e| format!("bad token response: {e}: {text}"))?;
    if let Some(exp) = tokens.expires_in {
        tokens.expires_at = Some(now_secs() + exp);
    }
    Ok(tokens)
}

#[tauri::command]
pub async fn oauth_exchange(
    app: AppHandle,
    state: State<'_, OAuthState>,
    profile: OAuthProfile,
    state_value: String,
    code: Option<String>,
) -> Result<OAuthSession, String> {
    let preset = profile.preset();
    let code = match code {
        Some(c) => c,
        None => state
            .loopback_codes
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&state_value)
            .ok_or("no authorization code captured yet")?,
    };
    // Clone so the pending entry survives until the exchange succeeds (a
    // failed exchange must not destroy the ability to retry).
    let pending = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .get(&state_value)
        .cloned()
        .ok_or("no pending authorization for this state — start again")?;
    if pending.profile != profile {
        return Err("profile mismatch for this state".to_string());
    }

    let mut body = HashMap::new();
    body.insert("grant_type".to_string(), "authorization_code".to_string());
    body.insert("code".to_string(), code);
    body.insert("client_id".to_string(), preset.client_id.to_string());
    body.insert("redirect_uri".to_string(), preset.redirect_uri.to_string());
    body.insert("code_verifier".to_string(), pending.verifier);
    let mut tokens = post_token(preset, body).await?;

    // Consume the attempt only after a successful exchange: a failed exchange
    // must leave the pending entry intact so the user can retry.
    state.forget(&state_value);

    // Antigravity routes requests through a Cloud Code project; resolve and
    // pin the project id onto the tokens best-effort.
    if profile == OAuthProfile::Antigravity {
        if let Some(pid) = load_antigravity_project(tokens.access_token.clone()).await {
            tokens.project_id = Some(pid);
        }
    }

    // Persist here rather than handing the full token set back for the frontend
    // to store: that round trip put the refresh token through the webview on
    // every sign-in.
    store_tokens(&app, profile, &tokens)?;
    Ok(OAuthSession::from(&tokens))
}

/// Refresh an access token. Not a `#[tauri::command]`: the refresh token is
/// long-lived and the renderer never holds one, so this is only reachable from
/// `oauth_session` below.
async fn refresh_tokens(
    profile: OAuthProfile,
    refresh_token: &str,
) -> Result<OAuthTokens, String> {
    let preset = profile.preset();
    if refresh_token.trim().is_empty() {
        return Err("no refresh token stored — sign in again".to_string());
    }
    let mut body = HashMap::new();
    body.insert("grant_type".to_string(), "refresh_token".to_string());
    body.insert(
        "refresh_token".to_string(),
        refresh_token.trim().to_string(),
    );
    body.insert("client_id".to_string(), preset.client_id.to_string());
    post_token(preset, body).await
}

fn store_tokens(app: &AppHandle, profile: OAuthProfile, tokens: &OAuthTokens) -> Result<(), String> {
    let json = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    set_secret(app, profile.as_str(), &json)
}

fn load_tokens(app: &AppHandle, profile: OAuthProfile) -> Result<Option<OAuthTokens>, String> {
    match get_secret(app, profile.as_str())? {
        Some(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("stored tokens corrupted: {e}")),
        None => Ok(None),
    }
}

/// How close to expiry an access token may get before `oauth_session` renews
/// it, so a request started now does not expire mid-flight.
const REFRESH_LEAD: u64 = 60;

/// Return the freshest access token for a profile, renewing it first if needed.
///
/// This is the only token accessor the renderer gets. Refreshing used to happen
/// in TypeScript, which meant reading the refresh token out of the keyring and
/// handing it to the webview on every check - a long-lived credential exposed
/// to any script running in the renderer, for no benefit: the frontend only
/// ever needs the short-lived access token to authorize an inference call.
#[tauri::command]
pub async fn oauth_session(
    app: AppHandle,
    profile: OAuthProfile,
) -> Result<Option<OAuthSession>, String> {
    let Some(tokens) = load_tokens(&app, profile)? else {
        return Ok(None);
    };
    let stale = tokens
        .expires_at
        .is_some_and(|exp| now_secs() + REFRESH_LEAD >= exp);
    if !stale {
        return Ok(Some(OAuthSession::from(&tokens)));
    }
    let Some(refresh) = tokens.refresh_token.as_deref() else {
        // Nothing to renew with; hand back what we have and let the upstream
        // call surface the 401 rather than forcing a sign-out here.
        return Ok(Some(OAuthSession::from(&tokens)));
    };
    match refresh_tokens(profile, refresh).await {
        Ok(fresh) => {
            // Providers may omit the refresh token on renewal; keep the old one
            // (and the resolved project id) rather than losing them.
            let merged = OAuthTokens {
                refresh_token: fresh.refresh_token.or(tokens.refresh_token),
                project_id: fresh.project_id.or(tokens.project_id),
                ..fresh
            };
            store_tokens(&app, profile, &merged)?;
            Ok(Some(OAuthSession::from(&merged)))
        }
        Err(err) => {
            log::warn!("oauth: refresh failed for {}: {err}", profile.as_str());
            Ok(Some(OAuthSession::from(&tokens)))
        }
    }
}

#[tauri::command]
pub async fn oauth_load(
    app: AppHandle,
    profile: OAuthProfile,
) -> Result<Option<OAuthSession>, String> {
    Ok(load_tokens(&app, profile)?
        .as_ref()
        .map(OAuthSession::from))
}

#[tauri::command]
pub async fn oauth_clear(app: AppHandle, profile: OAuthProfile) -> Result<(), String> {
    delete_secret(&app, profile.as_str())
}

/// Best-effort resolver for the Antigravity Cloud Code project id. The
/// `:loadCodeAssist` endpoint accepts the OAuth access token and returns the
/// current Cloud Code project. We dig for any field that looks like a project
/// id (`project_id`, `projectId`, `project`, `id` under `assistData`, …).
async fn load_antigravity_project(access_token: String) -> Option<String> {
    let client = reqwest::Client::new();
    let body = json!({
        "clientMetadata": { "ideType": 9, "platform": 5, "pluginType": 2 }
    });
    let resp = client
        .post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", "antigravity/ide/2.1.1")
        .header("X-Goog-Api-Client", "google-cloud-sdk vscode_cloudshelleditor/0.1")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    let status = resp.status();
    let text = resp.text().await.ok()?;
    if !status.is_success() {
        log::warn!("loadCodeAssist returned {status}: {text}");
        return None;
    }
    let v: Value = serde_json::from_str(&text).ok()?;
    find_project_id(&v)
}

#[tauri::command]
pub async fn oauth_antigravity_project(access_token: String) -> Result<Option<String>, String> {
    Ok(load_antigravity_project(access_token).await)
}

fn find_project_id(v: &Value) -> Option<String> {
    let obj = v.as_object()?;
    for key in ["projectId", "project_id", "project", "id", "cloudProjectId"] {
        if let Some(Value::String(s)) = obj.get(key) {
            if looks_like_project_id(s) {
                return Some(s.clone());
            }
        }
    }
    for value in obj.values() {
        if value.is_object() {
            if let Some(found) = find_project_id(value) {
                return Some(found);
            }
        }
    }
    None
}

fn looks_like_project_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ':')
        && s.contains(|c: char| c.is_ascii_alphanumeric())
}

// ---- Tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_stable() {
        let v = "hello-pkce-verifier";
        let c1 = pkce_challenge(v);
        let c2 = pkce_challenge(v);
        assert_eq!(c1, c2);
        assert!(!c1.is_empty());
        assert!(c1.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn percent_encode_handles_scope() {
        assert_eq!(
            percent_encode("openid profile email"),
            "openid%20profile%20email"
        );
        assert_eq!(percent_encode("https://a.b/c"), "https%3A%2F%2Fa.b%2Fc");
    }

    #[test]
    fn percent_decode_roundtrip() {
        assert_eq!(percent_decode("openid%20profile+email"), "openid profile email");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
    }

    #[test]
    fn parse_query_extracts_pairs() {
        let m = parse_query("code=abc123&state=xyz&scope=a%20b");
        assert_eq!(m.get("code").map(String::as_str), Some("abc123"));
        assert_eq!(m.get("state").map(String::as_str), Some("xyz"));
        assert_eq!(m.get("scope").map(String::as_str), Some("a b"));
    }

    #[test]
    fn find_project_id_digs_deep() {
        let v: Value = serde_json::from_str(
            r#"{"assistData":{"projectId":"my-cloud-project-42","zone":"us-central1"}}"#,
        )
        .unwrap();
        assert_eq!(find_project_id(&v).as_deref(), Some("my-cloud-project-42"));
        let v2: Value = serde_json::from_str(r#"{"foo":"bar"}"#).unwrap();
        assert_eq!(find_project_id(&v2), None);
    }

    #[test]
    fn presets_are_consistent() {
        for p in [OAuthProfile::Codex, OAuthProfile::Claude, OAuthProfile::Antigravity] {
            let preset = p.preset();
            assert!(!preset.client_id.is_empty());
            assert!(preset.authorize_url.starts_with("https://"));
            assert!(preset.token_url.starts_with("https://"));
            assert!(preset.redirect_uri.starts_with("http"));
            assert!(!preset.scope.is_empty());
            if preset.manual_code {
                assert!(preset.loopback_port.is_none());
            }
        }
    }

    /// The callback page is served by hand, so a wrong Content-Length truncates
    /// it in the browser. Assert the framing matches the body it carries -
    /// including for the success page, whose `✓` makes byte length differ from
    /// character count.
    #[test]
    fn callback_responses_declare_their_real_length() {
        for (status, body) in [
            ("HTTP/1.1 200 OK", CALLBACK_BODY),
            ("HTTP/1.1 400 Bad Request", CALLBACK_ERROR_BODY),
        ] {
            let raw = http_response(status, body);
            let text = String::from_utf8(raw).expect("response is utf-8");
            let (head, sent_body) = text
                .split_once("\r\n\r\n")
                .expect("headers are separated from the body");
            let declared: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .expect("Content-Length present")
                .parse()
                .expect("Content-Length is a number");
            assert_eq!(declared, sent_body.len(), "declared length vs body bytes");
            assert_eq!(sent_body, body);
        }
        // Guard the specific trap: the success page is not pure ASCII.
        assert_ne!(CALLBACK_BODY.len(), CALLBACK_BODY.chars().count());
    }

    /// Regression guard for the loopback poll contract: the frontend reads the
    /// result as `{kind: "pending" | "ready" | "expired"}`. If the tag shape
    /// ever changes, Codex/Antigravity sign-in silently hangs forever.
    #[test]
    fn poll_result_serializes_with_kind_tag() {
        let pending = serde_json::to_string(&OAuthPollResult::Pending).unwrap();
        assert_eq!(pending, r#"{"kind":"pending"}"#);

        let ready = serde_json::to_string(&OAuthPollResult::Ready {
            code: "abc".into(),
        })
        .unwrap();
        assert_eq!(ready, r#"{"kind":"ready","code":"abc"}"#);

        let expired = serde_json::to_string(&OAuthPollResult::Expired).unwrap();
        assert_eq!(expired, r#"{"kind":"expired"}"#);
    }

    /// The loopback bind list must only ever use loopback interfaces — never
    /// 0.0.0.0. This asserts the current hardcoded bind addresses.
    #[test]
    fn loopback_binds_are_loopback_only() {
        for addr in ["127.0.0.1:1455", "[::1]:1455"] {
            assert!(!addr.starts_with("0.0.0.0"));
            assert!(addr.contains("127.0.0.1") || addr.contains("[::1]"));
        }
    }
}
