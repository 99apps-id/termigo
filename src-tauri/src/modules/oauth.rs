//! OAuth 2.0 and Device Flow handlers for Termigo model providers.
//!
//! Supports:
//!   - `openai-codex` (OpenAI Codex / ChatGPT, PKCE on 127.0.0.1:1455)
//!   - `claude-oauth` (Anthropic Claude, PKCE on 127.0.0.1:54545)
//!   - `antigravity` (Google Antigravity, PKCE on 127.0.0.1:8085)
//!   - `xai-oauth` (xAI Grok, RFC 8628 Device Flow)
//!   - `github-copilot` (GitHub Copilot Device Flow + Copilot token exchange)
//!   - `muse` (Meta Muse Code Device Flow + key minting)

use std::time::Duration;

use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const TIMEOUT_SECS: u64 = 300;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OAuthTokens {
    pub provider: String,
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: Option<String>,
    pub expires_at: i64,
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DevicePrompt {
    pub provider: String,
    pub user_code: String,
    pub verification_uri: String,
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64(len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; len];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| "could not read the system random source".to_string())?;
    Ok(b64url(&buf))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn query(pairs: &[(&str, &str)]) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        ser.append_pair(k, v);
    }
    ser.finish()
}

fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn account_id_of(claims: &serde_json::Value) -> Option<String> {
    let direct = claims
        .get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_account_id"))
        .or_else(|| claims.get("chatgpt_account_id"))
        .or_else(|| {
            claims
                .get("https://api.openai.com/profile")
                .and_then(|a| a.get("chatgpt_account_id"))
        });
    if let Some(v) = direct.and_then(|v| v.as_str()) {
        return Some(v.to_string());
    }
    if let Some(obj) = claims.as_object() {
        for value in obj.values() {
            if let Some(inner) = value.as_object() {
                if let Some(v) = inner.get("chatgpt_account_id").and_then(|v| v.as_str()) {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn plan_of(claims: &serde_json::Value) -> Option<String> {
    claims
        .get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

async fn accept_callback(listener: &TcpListener, path_prefix: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("callback accept failed: {e}"))?;

        let mut buf = Vec::with_capacity(2048);
        let mut chunk = [0u8; 1024];
        let target = loop {
            let n = match stream.read(&mut chunk).await {
                Ok(0) => break None,
                Ok(n) => n,
                Err(e) => return Err(format!("callback read failed: {e}")),
            };
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                let text = String::from_utf8_lossy(&buf).to_string();
                break text
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .map(|s| s.to_string());
            }
        };

        let Some(target) = target else {
            continue;
        };

        if !target.starts_with(path_prefix) {
            let _ = stream
                .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n")
                .await;
            let _ = stream.shutdown().await;
            continue;
        }

        let body = "<!doctype html><meta charset=utf-8><title>Termigo</title>\
<body style=\"font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0a0a0a;color:#ededed\">\
<div style=\"text-align:center\"><p style=\"font-size:22px;margin:0 0 6px\">Signed in to Termigo</p>\
<p style=\"opacity:.6;margin:0\">You can close this tab and return to the application.</p></div>";
        let _ = stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .await;
        let _ = stream.shutdown().await;
        return Ok(target);
    }
}

// ── PKCE Flows ────────────────────────────────────────────────────────────────

async fn login_openai_codex(app: &tauri::AppHandle) -> Result<OAuthTokens, String> {
    const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
    const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
    const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
    const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
    const CALLBACK_ADDR: &str = "127.0.0.1:1455";
    const SCOPE: &str = "openid profile email offline_access";

    let verifier = random_b64(32)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16)?;

    let listener = TcpListener::bind(CALLBACK_ADDR).await.map_err(|e| {
        format!(
            "could not listen on {CALLBACK_ADDR} ({e}). Please close any process using port 1455 and try again."
        )
    })?;

    let auth_url = format!(
        "{AUTHORIZE_URL}?{}",
        query(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT_URI),
            ("scope", SCOPE),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", "codex_cli_rs"),
        ])
    );

    let _ = app.emit("chatgpt-auth-url", auth_url.clone());
    let _ = app.emit("oauth-auth-url", auth_url.clone());
    if let Err(e) = tauri_plugin_opener::open_url(auth_url.clone(), None::<&str>) {
        log::warn!("[oauth] could not open browser: {e}");
    }

    let target = tokio::time::timeout(
        Duration::from_secs(TIMEOUT_SECS),
        accept_callback(&listener, "/auth/callback"),
    )
    .await
    .map_err(|_| "timed out waiting for the browser sign-in".to_string())??;

    let parsed = url::Url::parse(&format!("http://localhost{target}"))
        .map_err(|e| format!("could not parse callback: {e}"))?;
    let mut code = None;
    let mut got_state = None;
    let mut err = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => got_state = Some(v.into_owned()),
            "error_description" | "error" => {
                err.get_or_insert(v.into_owned());
            }
            _ => continue,
        }
    }
    if let Some(e) = err {
        return Err(format!("sign-in was refused: {e}"));
    }
    if got_state.as_deref() != Some(state.as_str()) {
        return Err("the callback state did not match; sign-in abandoned".to_string());
    }
    let code = code.ok_or_else(|| "no authorization code in callback".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let form = query(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", CLIENT_ID),
        ("code_verifier", &verifier),
    ]);

    let res = client
        .post(TOKEN_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("user-agent", "codex_cli_rs/0.159.0")
        .header("originator", "codex_cli_rs")
        .body(form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("token endpoint returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct RawResp {
        access_token: String,
        refresh_token: Option<String>,
        id_token: Option<String>,
        expires_in: Option<i64>,
    }
    let parsed: RawResp = serde_json::from_str(&body)
        .map_err(|e| format!("could not parse token response: {e}"))?;

    let claims = parsed.id_token.as_deref().and_then(jwt_claims);
    Ok(OAuthTokens {
        provider: "openai-codex".to_string(),
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.unwrap_or_default(),
        id_token: parsed.id_token.clone(),
        expires_at: now_secs() + parsed.expires_in.unwrap_or(3600),
        account_id: claims.as_ref().and_then(account_id_of),
        email: claims
            .as_ref()
            .and_then(|c| c.get("email"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        plan: claims.as_ref().and_then(plan_of),
    })
}

async fn login_claude_oauth(app: &tauri::AppHandle) -> Result<OAuthTokens, String> {
    const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
    const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
    const TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
    const REDIRECT_URI: &str = "http://localhost:54545/callback";
    const CALLBACK_ADDR: &str = "127.0.0.1:54545";
    const SCOPE: &str = "org:create_api_key user:profile user:inference";

    let verifier = random_b64(32)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16)?;

    let listener = TcpListener::bind(CALLBACK_ADDR).await.map_err(|e| {
        format!(
            "could not listen on {CALLBACK_ADDR} ({e}). Please close any process using port 54545 and try again."
        )
    })?;

    let auth_url = format!(
        "{AUTHORIZE_URL}?{}",
        query(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT_URI),
            ("scope", SCOPE),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("code", "true"),
        ])
    );

    let _ = app.emit("oauth-auth-url", auth_url.clone());
    if let Err(e) = tauri_plugin_opener::open_url(auth_url.clone(), None::<&str>) {
        log::warn!("[oauth] could not open browser: {e}");
    }

    let target = tokio::time::timeout(
        Duration::from_secs(TIMEOUT_SECS),
        accept_callback(&listener, "/callback"),
    )
    .await
    .map_err(|_| "timed out waiting for browser sign-in".to_string())??;

    let parsed = url::Url::parse(&format!("http://localhost{target}"))
        .map_err(|e| format!("could not parse callback: {e}"))?;
    let mut code = None;
    let mut got_state = None;
    let mut err = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => got_state = Some(v.into_owned()),
            "error_description" | "error" => {
                err.get_or_insert(v.into_owned());
            }
            _ => continue,
        }
    }
    if let Some(e) = err {
        return Err(format!("sign-in refused: {e}"));
    }
    if got_state.as_deref() != Some(state.as_str()) {
        return Err("callback state mismatch".to_string());
    }
    let code = code.ok_or_else(|| "no code returned".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let payload = serde_json::json!({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "code_verifier": verifier,
        "state": state,
    });

    let res = client
        .post(TOKEN_URL)
        .header("content-type", "application/json")
        .header("user-agent", "claude-cli/2.1.280 (external, sdk-cli)")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("token endpoint returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct ClaudeResp {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: Option<i64>,
    }
    let parsed: ClaudeResp = serde_json::from_str(&body)
        .map_err(|e| format!("could not parse token response: {e}"))?;

    Ok(OAuthTokens {
        provider: "claude-oauth".to_string(),
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.unwrap_or_default(),
        id_token: None,
        expires_at: now_secs() + parsed.expires_in.unwrap_or(14400),
        account_id: None,
        email: None,
        plan: Some("Claude OAuth".to_string()),
    })
}

async fn login_antigravity(app: &tauri::AppHandle) -> Result<OAuthTokens, String> {
    let client_id = std::env::var("TERMIGO_ANTIGRAVITY_CLIENT_ID")
        .or_else(|_| std::env::var("TERMIXGO_ANTIGRAVITY_CLIENT_ID"))
        .unwrap_or_default();
    let client_secret = std::env::var("TERMIGO_ANTIGRAVITY_CLIENT_SECRET")
        .or_else(|_| std::env::var("TERMIXGO_ANTIGRAVITY_CLIENT_SECRET"))
        .unwrap_or_default();

    if client_id.trim().is_empty() {
        return Err("Antigravity requires TERMIGO_ANTIGRAVITY_CLIENT_ID in the environment or secrets".to_string());
    }

    const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
    const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
    const REDIRECT_URI: &str = "http://localhost:8085/auth/callback";
    const CALLBACK_ADDR: &str = "127.0.0.1:8085";

    let verifier = random_b64(32)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16)?;

    let listener = TcpListener::bind(CALLBACK_ADDR).await.map_err(|e| {
        format!("could not listen on {CALLBACK_ADDR} ({e}).")
    })?;

    let auth_url = format!(
        "{AUTHORIZE_URL}?{}",
        query(&[
            ("response_type", "code"),
            ("client_id", &client_id),
            ("redirect_uri", REDIRECT_URI),
            (
                "scope",
                "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
            ),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ])
    );

    let _ = app.emit("oauth-auth-url", auth_url.clone());
    let _ = tauri_plugin_opener::open_url(auth_url.clone(), None::<&str>);

    let target = tokio::time::timeout(
        Duration::from_secs(TIMEOUT_SECS),
        accept_callback(&listener, "/auth/callback"),
    )
    .await
    .map_err(|_| "timed out waiting for Google sign-in".to_string())??;

    let parsed = url::Url::parse(&format!("http://localhost{target}"))
        .map_err(|e| format!("could not parse callback: {e}"))?;
    let mut code = None;
    for (k, v) in parsed.query_pairs() {
        if k == "code" {
            code = Some(v.into_owned());
        }
    }
    let code = code.ok_or_else(|| "no code returned".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let form = query(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", &client_id),
        ("client_secret", &client_secret),
        ("code_verifier", &verifier),
    ]);

    let res = client
        .post(TOKEN_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("token endpoint returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct GoogleResp {
        access_token: String,
        refresh_token: Option<String>,
        id_token: Option<String>,
        expires_in: Option<i64>,
    }
    let parsed: GoogleResp = serde_json::from_str(&body)
        .map_err(|e| format!("could not parse response: {e}"))?;

    let claims = parsed.id_token.as_deref().and_then(jwt_claims);
    Ok(OAuthTokens {
        provider: "antigravity".to_string(),
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.unwrap_or_default(),
        id_token: parsed.id_token,
        expires_at: now_secs() + parsed.expires_in.unwrap_or(3600),
        account_id: None,
        email: claims
            .as_ref()
            .and_then(|c| c.get("email"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        plan: Some("Antigravity".to_string()),
    })
}

// ── Device Code Flows ────────────────────────────────────────────────────────

async fn login_xai_oauth(app: &tauri::AppHandle) -> Result<OAuthTokens, String> {
    const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
    const DEVICE_URL: &str = "https://auth.x.ai/oauth2/device/code";
    const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
    const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let res = client
        .post(DEVICE_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(query(&[("client_id", CLIENT_ID), ("scope", SCOPE)]))
        .send()
        .await
        .map_err(|e| format!("device code request failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("device code endpoint returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct DeviceResp {
        device_code: String,
        user_code: String,
        verification_uri: String,
        verification_uri_complete: Option<String>,
        #[serde(default)]
        interval: Option<u64>,
    }
    let dev: DeviceResp = serde_json::from_str(&body)
        .map_err(|e| format!("could not parse device response: {e}"))?;

    let target_uri = dev
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| dev.verification_uri.clone());

    let _ = app.emit(
        "oauth-device-prompt",
        DevicePrompt {
            provider: "xai-oauth".to_string(),
            user_code: dev.user_code.clone(),
            verification_uri: target_uri.clone(),
        },
    );
    let _ = tauri_plugin_opener::open_url(target_uri, None::<&str>);

    let interval = Duration::from_secs(dev.interval.unwrap_or(5).max(3));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(TIMEOUT_SECS);

    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("device authorization timed out".to_string());
        }
        tokio::time::sleep(interval).await;

        let res = client
            .post(TOKEN_URL)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(query(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", &dev.device_code),
                ("client_id", CLIENT_ID),
            ]))
            .send()
            .await;

        let res = match res {
            Ok(r) => r,
            Err(_) => continue,
        };

        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if status.is_success() {
            #[derive(Deserialize)]
            struct TokenResp {
                access_token: String,
                refresh_token: Option<String>,
                expires_in: Option<i64>,
            }
            let parsed: TokenResp = serde_json::from_str(&body)
                .map_err(|e| format!("could not parse token response: {e}"))?;
            return Ok(OAuthTokens {
                provider: "xai-oauth".to_string(),
                access_token: parsed.access_token,
                refresh_token: parsed.refresh_token.unwrap_or_default(),
                id_token: None,
                expires_at: now_secs() + parsed.expires_in.unwrap_or(3600),
                account_id: None,
                email: None,
                plan: Some("xAI Grok".to_string()),
            });
        }

        if body.contains("authorization_pending") || body.contains("slow_down") {
            continue;
        }
        return Err(format!("authorization failed: {body}"));
    }
}

async fn login_github_copilot(app: &tauri::AppHandle) -> Result<OAuthTokens, String> {
    const CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
    const DEVICE_URL: &str = "https://github.com/login/device/code";
    const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
    const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
    const SCOPE: &str = "read:user";

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let res = client
        .post(DEVICE_URL)
        .header("accept", "application/json")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(query(&[("client_id", CLIENT_ID), ("scope", SCOPE)]))
        .send()
        .await
        .map_err(|e| format!("github device code request failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("github device code returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct GhDeviceResp {
        device_code: String,
        user_code: String,
        verification_uri: String,
        #[serde(default)]
        interval: Option<u64>,
    }
    let dev: GhDeviceResp = serde_json::from_str(&body)
        .map_err(|e| format!("could not parse response: {e}"))?;

    let _ = app.emit(
        "oauth-device-prompt",
        DevicePrompt {
            provider: "github-copilot".to_string(),
            user_code: dev.user_code.clone(),
            verification_uri: dev.verification_uri.clone(),
        },
    );
    let _ = tauri_plugin_opener::open_url(dev.verification_uri.clone(), None::<&str>);

    let interval = Duration::from_secs(dev.interval.unwrap_or(5).max(3));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(TIMEOUT_SECS);

    let gh_access_token = loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("timed out waiting for GitHub Copilot authorization".to_string());
        }
        tokio::time::sleep(interval).await;

        let res = client
            .post(TOKEN_URL)
            .header("accept", "application/json")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(query(&[
                ("client_id", CLIENT_ID),
                ("device_code", &dev.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ]))
            .send()
            .await;

        let res = match res {
            Ok(r) => r,
            Err(_) => continue,
        };

        let body = res.text().await.unwrap_or_default();
        #[derive(Deserialize)]
        struct GhTokenResp {
            access_token: Option<String>,
            error: Option<String>,
        }
        if let Ok(parsed) = serde_json::from_str::<GhTokenResp>(&body) {
            if let Some(token) = parsed.access_token {
                break token;
            }
            if let Some(err) = parsed.error {
                if err == "authorization_pending" || err == "slow_down" {
                    continue;
                }
                return Err(format!("github auth refused: {err}"));
            }
        }
    };

    // Mint Copilot token from GitHub token
    let copilot_res = client
        .get(COPILOT_TOKEN_URL)
        .header("authorization", format!("token {gh_access_token}"))
        .header("user-agent", "GitHubCopilotChat/0.38.0")
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("copilot token request failed: {e}"))?;

    let copilot_status = copilot_res.status();
    let copilot_body = copilot_res.text().await.unwrap_or_default();
    if !copilot_status.is_success() {
        return Err(format!("copilot mint endpoint returned {copilot_status}: {copilot_body}"));
    }

    #[derive(Deserialize)]
    struct CopilotResp {
        token: String,
        expires_at: Option<i64>,
    }
    let copilot: CopilotResp = serde_json::from_str(&copilot_body)
        .map_err(|e| format!("could not parse copilot token response: {e}"))?;

    Ok(OAuthTokens {
        provider: "github-copilot".to_string(),
        access_token: copilot.token,
        refresh_token: gh_access_token,
        id_token: None,
        expires_at: copilot.expires_at.unwrap_or_else(|| now_secs() + 1800),
        account_id: None,
        email: None,
        plan: Some("GitHub Copilot".to_string()),
    })
}

async fn login_muse(app: &tauri::AppHandle) -> Result<OAuthTokens, String> {
    const CLIENT_ID: &str = "1031625952748946";
    const DEVICE_URL: &str = "https://auth.meta.com/oidc/device/authorization/";
    const TOKEN_URL: &str = "https://auth.meta.com/oidc/device/token/";
    const MINT_URL: &str = "https://api.meta.ai/muse-code/key";

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let res = client
        .post(DEVICE_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(query(&[("client_id", CLIENT_ID)]))
        .send()
        .await
        .map_err(|e| format!("meta device code request failed: {e}"))?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("meta device code returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct MetaDevResp {
        device_code: String,
        user_code: String,
        verification_uri: Option<String>,
        #[serde(default)]
        interval: Option<u64>,
    }
    let dev: MetaDevResp = serde_json::from_str(&body)
        .map_err(|e| format!("could not parse meta device response: {e}"))?;

    let verify_url = dev
        .verification_uri
        .unwrap_or_else(|| "https://auth.meta.com/oauth/device/".to_string());

    let _ = app.emit(
        "oauth-device-prompt",
        DevicePrompt {
            provider: "muse".to_string(),
            user_code: dev.user_code.clone(),
            verification_uri: verify_url.clone(),
        },
    );
    let _ = tauri_plugin_opener::open_url(verify_url, None::<&str>);

    let interval = Duration::from_secs(dev.interval.unwrap_or(5).max(3));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(TIMEOUT_SECS);

    let dca_token = loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("timed out waiting for Meta Muse authorization".to_string());
        }
        tokio::time::sleep(interval).await;

        let res = client
            .post(TOKEN_URL)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(query(&[
                ("client_id", CLIENT_ID),
                ("device_code", &dev.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ]))
            .send()
            .await;

        let res = match res {
            Ok(r) => r,
            Err(_) => continue,
        };

        let body = res.text().await.unwrap_or_default();
        #[derive(Deserialize)]
        struct MetaTokenResp {
            access_token: Option<String>,
            error: Option<String>,
        }
        if let Ok(parsed) = serde_json::from_str::<MetaTokenResp>(&body) {
            if let Some(token) = parsed.access_token {
                break token;
            }
            if let Some(err) = parsed.error {
                if err == "authorization_pending" || err == "slow_down" {
                    continue;
                }
                return Err(format!("meta auth refused: {err}"));
            }
        }
    };

    // Mint Muse API key from DCA token
    let mint_res = client
        .post(MINT_URL)
        .header("authorization", format!("Bearer {dca_token}"))
        .header("user-agent", "muse-code/1.0.2")
        .header("x-api-version", "1.0.0")
        .json(&serde_json::json!({ "onboard": true }))
        .send()
        .await
        .map_err(|e| format!("muse key mint failed: {e}"))?;

    let mint_status = mint_res.status();
    let mint_body = mint_res.text().await.unwrap_or_default();
    if !mint_status.is_success() {
        return Err(format!("muse mint returned {mint_status}: {mint_body}"));
    }

    #[derive(Deserialize)]
    struct MintResp {
        api_key: Option<String>,
        key: Option<String>,
        user_email: Option<String>,
    }
    let minted: MintResp = serde_json::from_str(&mint_body)
        .map_err(|e| format!("could not parse mint response: {e}"))?;

    let key = minted
        .api_key
        .or(minted.key)
        .ok_or_else(|| "mint response had no api_key".to_string())?;

    Ok(OAuthTokens {
        provider: "muse".to_string(),
        access_token: key,
        refresh_token: dca_token,
        id_token: None,
        expires_at: 0, // stable account key
        account_id: minted.user_email.clone(),
        email: minted.user_email,
        plan: Some("Meta Muse Code".to_string()),
    })
}

// ── Refresh Implementation ──────────────────────────────────────────────────

async fn do_refresh_token(provider: &str, refresh_token: &str) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    match provider {
        "openai-codex" | "chatgpt" => {
            const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
            const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
            const SCOPE: &str = "openid profile email offline_access";

            let form = query(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", CLIENT_ID),
                ("scope", SCOPE),
            ]);

            let res = client
                .post(TOKEN_URL)
                .header("content-type", "application/x-www-form-urlencoded")
                .header("user-agent", "codex_cli_rs/0.159.0")
                .header("originator", "codex_cli_rs")
                .body(form)
                .send()
                .await
                .map_err(|e| format!("refresh request failed: {e}"))?;

            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("token endpoint returned {status}: {body}"));
            }

            #[derive(Deserialize)]
            struct RawResp {
                access_token: String,
                refresh_token: Option<String>,
                id_token: Option<String>,
                expires_in: Option<i64>,
            }
            let parsed: RawResp = serde_json::from_str(&body)
                .map_err(|e| format!("could not parse token response: {e}"))?;

            let claims = parsed.id_token.as_deref().and_then(jwt_claims);
            Ok(OAuthTokens {
                provider: "openai-codex".to_string(),
                access_token: parsed.access_token,
                refresh_token: parsed
                    .refresh_token
                    .unwrap_or_else(|| refresh_token.to_string()),
                id_token: parsed.id_token,
                expires_at: now_secs() + parsed.expires_in.unwrap_or(3600),
                account_id: claims.as_ref().and_then(account_id_of),
                email: claims
                    .as_ref()
                    .and_then(|c| c.get("email"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                plan: claims.as_ref().and_then(plan_of),
            })
        }
        "claude-oauth" => {
            const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
            const TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";

            let payload = serde_json::json!({
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CLIENT_ID,
            });

            let res = client
                .post(TOKEN_URL)
                .header("content-type", "application/json")
                .header("user-agent", "claude-cli/2.1.280 (external, sdk-cli)")
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("claude refresh failed: {e}"))?;

            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("claude refresh returned {status}: {body}"));
            }

            #[derive(Deserialize)]
            struct ClaudeResp {
                access_token: String,
                refresh_token: Option<String>,
                expires_in: Option<i64>,
            }
            let parsed: ClaudeResp = serde_json::from_str(&body)
                .map_err(|e| format!("could not parse response: {e}"))?;

            Ok(OAuthTokens {
                provider: "claude-oauth".to_string(),
                access_token: parsed.access_token,
                refresh_token: parsed
                    .refresh_token
                    .unwrap_or_else(|| refresh_token.to_string()),
                id_token: None,
                expires_at: now_secs() + parsed.expires_in.unwrap_or(14400),
                account_id: None,
                email: None,
                plan: Some("Claude OAuth".to_string()),
            })
        }
        "github-copilot" => {
            const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
            let copilot_res = client
                .get(COPILOT_TOKEN_URL)
                .header("authorization", format!("token {refresh_token}"))
                .header("user-agent", "GitHubCopilotChat/0.38.0")
                .header("accept", "application/json")
                .send()
                .await
                .map_err(|e| format!("copilot token refresh failed: {e}"))?;

            let status = copilot_res.status();
            let body = copilot_res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("copilot refresh returned {status}: {body}"));
            }

            #[derive(Deserialize)]
            struct CopilotResp {
                token: String,
                expires_at: Option<i64>,
            }
            let copilot: CopilotResp = serde_json::from_str(&body)
                .map_err(|e| format!("could not parse copilot token response: {e}"))?;

            Ok(OAuthTokens {
                provider: "github-copilot".to_string(),
                access_token: copilot.token,
                refresh_token: refresh_token.to_string(),
                id_token: None,
                expires_at: copilot.expires_at.unwrap_or_else(|| now_secs() + 1800),
                account_id: None,
                email: None,
                plan: Some("GitHub Copilot".to_string()),
            })
        }
        "muse" => {
            const MINT_URL: &str = "https://api.meta.ai/muse-code/key";
            let mint_res = client
                .post(MINT_URL)
                .header("authorization", format!("Bearer {refresh_token}"))
                .header("user-agent", "muse-code/1.0.2")
                .header("x-api-version", "1.0.0")
                .json(&serde_json::json!({ "onboard": true }))
                .send()
                .await
                .map_err(|e| format!("muse key remint failed: {e}"))?;

            let status = mint_res.status();
            let body = mint_res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("muse mint returned {status}: {body}"));
            }

            #[derive(Deserialize)]
            struct MintResp {
                api_key: Option<String>,
                key: Option<String>,
                user_email: Option<String>,
            }
            let minted: MintResp = serde_json::from_str(&body)
                .map_err(|e| format!("could not parse mint response: {e}"))?;

            let key = minted
                .api_key
                .or(minted.key)
                .ok_or_else(|| "mint response had no api_key".to_string())?;

            Ok(OAuthTokens {
                provider: "muse".to_string(),
                access_token: key,
                refresh_token: refresh_token.to_string(),
                id_token: None,
                expires_at: 0,
                account_id: minted.user_email.clone(),
                email: minted.user_email,
                plan: Some("Meta Muse Code".to_string()),
            })
        }
        "xai-oauth" => {
            const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
            const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";

            let form = query(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", CLIENT_ID),
            ]);

            let res = client
                .post(TOKEN_URL)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(form)
                .send()
                .await
                .map_err(|e| format!("xai refresh failed: {e}"))?;

            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("xai refresh returned {status}: {body}"));
            }

            #[derive(Deserialize)]
            struct TokenResp {
                access_token: String,
                refresh_token: Option<String>,
                expires_in: Option<i64>,
            }
            let parsed: TokenResp = serde_json::from_str(&body)
                .map_err(|e| format!("could not parse token response: {e}"))?;

            Ok(OAuthTokens {
                provider: "xai-oauth".to_string(),
                access_token: parsed.access_token,
                refresh_token: parsed
                    .refresh_token
                    .unwrap_or_else(|| refresh_token.to_string()),
                id_token: None,
                expires_at: now_secs() + parsed.expires_in.unwrap_or(3600),
                account_id: None,
                email: None,
                plan: Some("xAI Grok".to_string()),
            })
        }
        "antigravity" => {
            let client_id = std::env::var("TERMIGO_ANTIGRAVITY_CLIENT_ID")
                .or_else(|_| std::env::var("TERMIXGO_ANTIGRAVITY_CLIENT_ID"))
                .unwrap_or_default();
            let client_secret = std::env::var("TERMIGO_ANTIGRAVITY_CLIENT_SECRET")
                .or_else(|_| std::env::var("TERMIXGO_ANTIGRAVITY_CLIENT_SECRET"))
                .unwrap_or_default();
            const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

            let form = query(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", &client_id),
                ("client_secret", &client_secret),
            ]);

            let res = client
                .post(TOKEN_URL)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(form)
                .send()
                .await
                .map_err(|e| format!("google refresh failed: {e}"))?;

            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("google refresh returned {status}: {body}"));
            }

            #[derive(Deserialize)]
            struct GoogleResp {
                access_token: String,
                refresh_token: Option<String>,
                expires_in: Option<i64>,
            }
            let parsed: GoogleResp = serde_json::from_str(&body)
                .map_err(|e| format!("could not parse response: {e}"))?;

            Ok(OAuthTokens {
                provider: "antigravity".to_string(),
                access_token: parsed.access_token,
                refresh_token: parsed
                    .refresh_token
                    .unwrap_or_else(|| refresh_token.to_string()),
                id_token: None,
                expires_at: now_secs() + parsed.expires_in.unwrap_or(3600),
                account_id: None,
                email: None,
                plan: Some("Antigravity".to_string()),
            })
        }
        _ => Err(format!("unsupported OAuth provider: {provider}")),
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn oauth_login(app: tauri::AppHandle, provider: String) -> Result<OAuthTokens, String> {
    match provider.as_str() {
        "openai-codex" | "chatgpt" => login_openai_codex(&app).await,
        "claude-oauth" => login_claude_oauth(&app).await,
        "antigravity" => login_antigravity(&app).await,
        "xai-oauth" => login_xai_oauth(&app).await,
        "github-copilot" => login_github_copilot(&app).await,
        "muse" => login_muse(&app).await,
        _ => Err(format!("unknown OAuth provider: {provider}")),
    }
}

#[tauri::command]
pub async fn oauth_refresh(provider: String, refresh_token: String) -> Result<OAuthTokens, String> {
    if refresh_token.trim().is_empty() {
        return Err("no refresh token stored; sign in again".to_string());
    }
    do_refresh_token(&provider, &refresh_token).await
}
