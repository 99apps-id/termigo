use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

const HEADER_BLOCKLIST: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "transfer-encoding",
    "upgrade",
    "trailer",
    "expect",
];

fn is_blocked_host_name(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    matches!(
        host.as_str(),
        "metadata.google.internal" | "metadata" | "metadata.azure.com"
    )
}

fn ip_kind(ip: IpAddr) -> IpKind {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            // Cloud metadata IPv4: 169.254.169.254
            if v.is_link_local() {
                return IpKind::BlockedMetadata;
            }
            if v.is_loopback() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // RFC1918 + CGNAT + benchmarking + IETF
            if o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
            {
                return IpKind::Private;
            }
            IpKind::Public
        }
        IpAddr::V6(v) => {
            if v.is_loopback() || v.is_unspecified() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // Cloud metadata IPv6 (AWS): fd00:ec2::254
            let segs = v.segments();
            if segs[0] == 0xfd00 && segs[1] == 0xec2 {
                return IpKind::BlockedMetadata;
            }
            // fe80::/10 link-local
            if segs[0] & 0xffc0 == 0xfe80 {
                return IpKind::BlockedMetadata;
            }
            // fc00::/7 unique-local (private)
            if segs[0] & 0xfe00 == 0xfc00 {
                return IpKind::Private;
            }
            IpKind::Public
        }
    }
}

/// Redirect policy shared by extension downloads: refuse link-local /
/// cloud-metadata destinations and cap redirect depth. Reuses the same
/// host/IP classification as the AI provider proxy so a malicious
/// extension-host redirect cannot reach the instance metadata service.
pub(crate) fn ssrf_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 10 {
            return attempt.error("too many redirects");
        }
        let next = attempt.url();
        if next.scheme() != "http" && next.scheme() != "https" {
            return attempt.stop();
        }
        let Some(host) = next.host_str() else {
            return attempt.stop();
        };
        if is_blocked_host_name(host) {
            return attempt.stop();
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            if ip_kind(ip) == IpKind::BlockedMetadata {
                return attempt.stop();
            }
        }
        attempt.follow()
    })
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum IpKind {
    Public,
    Private,
    Loopback,
    BlockedMetadata,
}

/// Resolve `host` once and return both its safety classification and the
/// concrete IPs we resolved. Callers can pin reqwest to these IPs to defeat
/// DNS rebinding (where a second lookup returns a different address).
async fn resolve_and_classify(host: &str) -> Result<(IpKind, Vec<IpAddr>), String> {
    // Direct literal? Skip DNS.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok((ip_kind(ip), vec![ip]));
    }
    let host_owned = host.to_string();
    let lookup = tokio::task::spawn_blocking(move || {
        (host_owned.as_str(), 0u16)
            .to_socket_addrs()
            .map(|it| it.map(|a| a.ip()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("dns: {e}"))?;
    if lookup.is_empty() {
        return Err("dns: no addresses".into());
    }
    let mut worst = IpKind::Public;
    for ip in &lookup {
        let k = ip_kind(*ip);
        worst = match (worst, k) {
            (_, IpKind::BlockedMetadata) => IpKind::BlockedMetadata,
            (IpKind::BlockedMetadata, _) => IpKind::BlockedMetadata,
            (IpKind::Public, x) => x,
            (x, IpKind::Public) => x,
            (a, _) => a,
        };
    }
    Ok((worst, lookup))
}

use std::net::ToSocketAddrs;

fn validate_url(url: &str, allow_private: bool) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("userinfo in url is not allowed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?;
    if is_blocked_host_name(host) {
        return Err(format!("host not allowed: {host}"));
    }
    // The actual IP classification has to be async — caller does it.
    let _ = allow_private;
    Ok(parsed)
}

/// Classify the host AND return safe IPs to pin reqwest's resolver to.
/// Defeats DNS rebinding (second-lookup-returns-different-IP) by reusing
/// exactly the addresses that passed `ip_kind`.
async fn classify_and_collect_safe_ips(
    host: &str,
    allow_private: bool,
) -> Result<Vec<IpAddr>, String> {
    let (worst, ips) = resolve_and_classify(host).await?;
    match worst {
        IpKind::BlockedMetadata => return Err(format!("host not allowed: {host}")),
        IpKind::Loopback | IpKind::Private if !allow_private => {
            return Err(format!(
                "host {host} resolves to a private/loopback address; this endpoint requires explicit opt-in",
            ));
        }
        _ => {}
    }
    let safe: Vec<IpAddr> = ips
        .into_iter()
        .filter(|ip| match ip_kind(*ip) {
            IpKind::BlockedMetadata => false,
            IpKind::Loopback | IpKind::Private => allow_private,
            IpKind::Public => true,
        })
        .collect();
    if safe.is_empty() {
        return Err(format!("host {host}: no safe IPs"));
    }
    Ok(safe)
}

fn sanitize_headers(headers: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(h) = headers else { return Ok(map) };
    for (k, v) in h {
        let lower = k.to_ascii_lowercase();
        if HEADER_BLOCKLIST.contains(&lower.as_str()) {
            return Err(format!("header not allowed: {k}"));
        }
        // CRLF injection: header value must not contain CR / LF / NUL.
        if v.as_bytes().iter().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return Err(format!("header value contains control bytes: {k}"));
        }
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
        let value = HeaderValue::from_str(&v).map_err(|e| e.to_string())?;
        map.insert(name, value);
    }
    Ok(map)
}

#[tauri::command]
pub async fn lm_ping(base_url: String) -> Result<u16, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("empty base url".into());
    }
    let probe = format!("{trimmed}/models");
    let parsed = validate_url(&probe, true)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?
        .to_string();
    let safe_ips = classify_and_collect_safe_ips(&host, true).await?;

    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    let addrs: Vec<SocketAddr> = safe_ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
    builder = builder.resolve_to_addrs(&host, &addrs);
    let client = builder.build().map_err(|e| e.to_string())?;
    client
        .get(parsed)
        .send()
        .await
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}
// AI HTTP proxy — bypasses webview CORS / Mixed-Content / PNA so local-network
// model servers (LM Studio, Ollama, vLLM) work in the production bundle.

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

fn build_request(
    client: &reqwest::Client,
    method: &str,
    url: reqwest::Url,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
) -> Result<reqwest::RequestBuilder, String> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    let map = sanitize_headers(headers)?;
    req = req.headers(map);
    if let Some(b) = body {
        req = req.body(b);
    }
    Ok(req)
}

/// How long a cached client keeps serving before its host is resolved again.
const CLIENT_TTL: Duration = Duration::from_secs(300);

struct CachedClient {
    client: reqwest::Client,
    made: Instant,
}

/// Provider clients, kept per host and network policy.
///
/// Every AI request used to build its own `reqwest::Client`, and a client owns
/// its connection pool - so discarding it after one request made keep-alive
/// impossible. Each request paid a DNS lookup and a fresh TCP + TLS handshake,
/// measured at roughly half a second of handshake alone, on every step of
/// every run.
///
/// It also gave every request its own chance to fail. A connect that stalls
/// past the connect timeout ends the request, and with nothing reused, each
/// one rolled that dice again - which is how a single slow link produced
/// "client error (connect): deadline has elapsed" rather than one slow first
/// call and fast ones after.
///
/// Entries expire so a provider that moves its endpoint is followed within a
/// few minutes. Until then the pinned addresses are reused, which keeps the
/// guarantee `resolve_to_addrs` exists for: a connection may still only use
/// addresses that passed `ip_kind`.
static CLIENT_CACHE: OnceLock<Mutex<HashMap<(String, bool), CachedClient>>> = OnceLock::new();

async fn client_for(host: &str, allow_private: bool) -> Result<reqwest::Client, String> {
    let key = (host.to_string(), allow_private);
    let cache = CLIENT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    // Scoped so the guard is dropped before the await below: holding a
    // std::sync::Mutex across one is both wrong and slow.
    {
        if let Ok(map) = cache.lock() {
            if let Some(entry) = map.get(&key) {
                if entry.made.elapsed() < CLIENT_TTL {
                    // Cloning shares the pool rather than copying it.
                    return Ok(entry.client.clone());
                }
            }
        }
    }

    let safe_ips = classify_and_collect_safe_ips(host, allow_private).await?;
    let client = build_safe_client(allow_private, &[(host.to_string(), safe_ips)])?;
    // Two concurrent misses both resolve and the later one wins. That costs a
    // duplicate lookup, which is cheaper than holding the lock across DNS.
    if let Ok(mut map) = cache.lock() {
        map.insert(
            key,
            CachedClient {
                client: client.clone(),
                made: Instant::now(),
            },
        );
    }
    Ok(client)
}

fn build_safe_client(
    allow_private: bool,
    pinned: &[(String, Vec<IpAddr>)],
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10));
    // Pin reqwest's resolver to the IPs we just classified. Without this,
    // reqwest's own DNS lookup could return a different (private/metadata) IP
    // for the same hostname between classify and connect — classic DNS
    // rebinding attack. We pin port 0 because reqwest fills in the actual
    // port from the URL when wiring up the override map.
    for (host, ips) in pinned {
        let addrs: Vec<SocketAddr> = ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
        if !addrs.is_empty() {
            builder = builder.resolve_to_addrs(host, &addrs);
        }
    }
    builder
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 10 {
                return attempt.error("too many redirects");
            }
            let next = attempt.url();
            match next.scheme() {
                "http" | "https" => {}
                _ => return attempt.stop(),
            }
            if next.username() != "" || next.password().is_some() {
                return attempt.stop();
            }
            let Some(host) = next.host_str() else {
                return attempt.stop();
            };
            if is_blocked_host_name(host) {
                return attempt.stop();
            }
            if let Ok(ip) = host.parse::<IpAddr>() {
                let k = ip_kind(ip);
                if k == IpKind::BlockedMetadata {
                    return attempt.stop();
                }
                if !allow_private && matches!(k, IpKind::Loopback | IpKind::Private) {
                    return attempt.stop();
                }
            } else if !allow_private {
                if let Some(prev) = attempt.previous().last() {
                    if prev.host_str() != Some(host) {
                        return attempt.stop();
                    }
                }
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn header_map_to_strings(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(headers.len());
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    out
}

#[tauri::command]
pub async fn ai_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
) -> Result<HttpResponse, String> {
    let allow_private = allow_private_network.unwrap_or(false);
    let parsed = validate_url(&url, allow_private)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?
        .to_string();
    let client = client_for(&host, allow_private).await?;

    let req = build_request(&client, &method, parsed, headers, body)?;
    let resp = req.send().await.map_err(|e| describe_error(&e))?;

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let body = resp
        .bytes()
        .await
        .map_err(|e| describe_error(&e))?
        .to_vec();
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        /// Base64 rather than a byte array. A `Vec<u8>` serializes as a JSON
        /// array of decimal numbers - about three bytes of transport per byte
        /// of payload - and every chunk under 8 KB is injected into the webview
        /// as JavaScript source, so that inflation is paid as script the engine
        /// then has to parse. Base64 costs 1.33x and decodes natively.
        b64: String,
    },
    End,
    Error {
        message: String,
    },
}

/// Render an error with everything under it.
///
/// reqwest's `Display` prints only the outer frame - "error sending request for
/// url (...)" - and drops the cause, which is the half that says anything:
/// whether the connection was refused, reset mid-flight, timed out, failed DNS,
/// or presented a certificate that would not verify. Reported without it, every
/// transport failure reads identically and none of them is actionable.
fn describe_error(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        // Some layers repeat the frame above them; adding it twice only makes
        // the message longer.
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = cause.source();
    }
    out
}

/// How the webview hands over a request body.
///
/// Every AI call sends JSON, which is already text and needs no encoding at
/// all - it used to be walked into a `number[]`, tripling it on the way across
/// and again on the way back out. Binary bodies are rare here, so they pay
/// base64 rather than making the common case pay for them.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RequestBody {
    Text { text: String },
    Base64 { data: String },
}

impl RequestBody {
    fn into_bytes(self) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        match self {
            Self::Text { text } => Ok(text.into_bytes()),
            Self::Base64 { data } => base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .map_err(|e| format!("invalid base64 request body: {e}")),
        }
    }
}

#[tauri::command]
pub async fn ai_http_stream(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<RequestBody>,
    allow_private_network: Option<bool>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let allow_private = allow_private_network.unwrap_or(false);
    let body = match body.map(RequestBody::into_bytes).transpose() {
        Ok(b) => b,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let parsed = match validate_url(&url, allow_private) {
        Ok(p) => p,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => {
            let e = "missing host".to_string();
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let client = match client_for(&host, allow_private).await {
        Ok(c) => c,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };

    let req = build_request(&client, &method, parsed, headers, body)?;
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let message = describe_error(&e);
            let _ = on_event.send(AiStreamEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let _ = on_event.send(AiStreamEvent::Headers { status, headers });

    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                use base64::Engine as _;
                let bytes: Bytes = chunk;
                if on_event
                    .send(AiStreamEvent::Chunk {
                        b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    })
                    .is_err()
                {
                    // Channel dropped (frontend aborted) — stop streaming.
                    return Ok(());
                }
            }
            Err(e) => {
                let message = describe_error(&e);
                let _ = on_event.send(AiStreamEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        }
    }

    let _ = on_event.send(AiStreamEvent::End);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn metadata_ips_classified_as_blocked() {
        // AWS / Google / Azure all share the IPv4 169.254.169.254 link-local.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))),
            IpKind::BlockedMetadata
        );
        // AWS IPv6 metadata
        assert_eq!(
            ip_kind("fd00:ec2::254".parse().unwrap()),
            IpKind::BlockedMetadata
        );
        // Any link-local IPv4 (169.254/16) — same network range, still blocked.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))),
            IpKind::BlockedMetadata
        );
        // IPv6 link-local fe80::/10
        assert_eq!(
            ip_kind("fe80::1".parse().unwrap()),
            IpKind::BlockedMetadata
        );
    }

    #[test]
    fn private_ips_classified_correctly() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))),
            IpKind::Private
        );
        // CGNAT 100.64/10
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
            IpKind::Private
        );
    }

    #[test]
    fn loopback_classified_as_loopback() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            IpKind::Loopback
        );
        assert_eq!(ip_kind("::1".parse().unwrap()), IpKind::Loopback);
    }

    #[test]
    fn public_ips_classified_as_public() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))),
            IpKind::Public
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))),
            IpKind::Public
        );
    }

    #[test]
    fn validate_url_blocks_userinfo_and_metadata_hostnames() {
        // URLs with userinfo can confuse browsers / leak creds in redirects.
        assert!(validate_url("http://user:pass@example.com/", true).is_err());
        // Cloud metadata-by-name.
        assert!(validate_url("http://metadata.google.internal/", true).is_err());
        assert!(validate_url("http://metadata/", true).is_err());
        assert!(validate_url("http://metadata.azure.com/", true).is_err());
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        assert!(validate_url("ftp://example.com/", true).is_err());
        assert!(validate_url("file:///etc/passwd", true).is_err());
        assert!(validate_url("javascript:alert(1)", true).is_err());
    }

    #[test]
    fn sanitize_headers_blocks_crlf_injection() {
        let mut h = HashMap::new();
        h.insert("X-Foo".to_string(), "bar\r\nX-Evil: yes".to_string());
        assert!(sanitize_headers(Some(h)).is_err());
    }

    #[test]
    fn sanitize_headers_blocks_hop_by_hop_headers() {
        for hop in [
            "host",
            "content-length",
            "connection",
            "proxy-authorization",
        ] {
            let mut h = HashMap::new();
            h.insert(hop.to_string(), "value".to_string());
            assert!(
                sanitize_headers(Some(h)).is_err(),
                "expected {hop} to be rejected"
            );
        }
    }

    // A body used to arrive as a JSON array of decimal numbers. Text now
    // crosses as itself, so these guard the decode on the other side.
    #[test]
    fn text_body_crosses_without_encoding() {
        let b: RequestBody = serde_json::from_str(r#"{"kind":"text","text":"{\"a\":1}"}"#)
            .expect("parses");
        assert_eq!(b.into_bytes().unwrap(), br#"{"a":1}"#.to_vec());
    }

    #[test]
    fn text_body_keeps_multibyte_characters() {
        let b = RequestBody::Text {
            text: "halo — 日本語 🎉".to_string(),
        };
        assert_eq!(
            String::from_utf8(b.into_bytes().unwrap()).unwrap(),
            "halo — 日本語 🎉"
        );
    }

    #[test]
    fn base64_body_round_trips_every_byte() {
        use base64::Engine as _;
        let raw: Vec<u8> = (0u16..=255).map(|n| n as u8).collect();
        let b = RequestBody::Base64 {
            data: base64::engine::general_purpose::STANDARD.encode(&raw),
        };
        assert_eq!(b.into_bytes().unwrap(), raw);
    }

    #[test]
    fn malformed_base64_is_reported_not_silently_dropped() {
        let b = RequestBody::Base64 {
            data: "not valid base64!!".to_string(),
        };
        let err = b.into_bytes().unwrap_err();
        assert!(
            err.contains("invalid base64 request body"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn empty_bodies_are_empty_not_errors() {
        assert!(RequestBody::Text { text: String::new() }
            .into_bytes()
            .unwrap()
            .is_empty());
        assert!(RequestBody::Base64 { data: String::new() }
            .into_bytes()
            .unwrap()
            .is_empty());
    }

    // reqwest hides the useful half of a transport failure under `source()`,
    // so every one of them used to reach the user as the same sentence.
    #[test]
    fn describe_error_includes_the_cause_chain() {
        #[derive(Debug)]
        struct Inner;
        impl std::fmt::Display for Inner {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "connection reset by peer (os error 10054)")
            }
        }
        impl std::error::Error for Inner {}

        #[derive(Debug)]
        struct Outer(Inner);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "error sending request for url (https://example.com)")
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let text = describe_error(&Outer(Inner));
        assert!(text.contains("error sending request"), "{text}");
        assert!(text.contains("os error 10054"), "{text}");
    }

    #[test]
    fn describe_error_does_not_repeat_a_frame() {
        #[derive(Debug)]
        struct Echo;
        impl std::fmt::Display for Echo {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "same text")
            }
        }
        impl std::error::Error for Echo {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                None
            }
        }
        assert_eq!(describe_error(&Echo), "same text");
    }

    #[test]
    fn describe_error_handles_an_error_with_no_source() {
        #[derive(Debug)]
        struct Bare;
        impl std::fmt::Display for Bare {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "dns error")
            }
        }
        impl std::error::Error for Bare {}
        assert_eq!(describe_error(&Bare), "dns error");
    }

    // The point of the cache is that a second request to the same host does not
    // connect again. An IP literal skips DNS entirely (see
    // `resolve_and_classify`), so this exercises the caching without a lookup.
    #[tokio::test]
    async fn same_host_reuses_one_client() {
        let host = "203.0.113.7"; // TEST-NET-3, never routed
        let first = client_for(host, false).await.expect("builds");
        let second = client_for(host, false).await.expect("reuses");

        let map = CLIENT_CACHE.get().expect("initialised").lock().unwrap();
        assert_eq!(
            map.keys().filter(|(h, _)| h == host).count(),
            1,
            "a second request should not add a second client"
        );
        drop(map);
        // Cloned clients share a pool; both being usable is the observable part.
        drop((first, second));
    }

    #[tokio::test]
    async fn network_policy_is_part_of_the_key() {
        // 127.0.0.1 is refused unless private networks are opted into, so the
        // two policies must never share an entry.
        let host = "127.0.0.1";
        assert!(client_for(host, false).await.is_err());
        assert!(client_for(host, true).await.is_ok());

        let map = CLIENT_CACHE.get().expect("initialised").lock().unwrap();
        assert!(map.contains_key(&(host.to_string(), true)));
        assert!(
            !map.contains_key(&(host.to_string(), false)),
            "a refused host must not be cached as usable"
        );
    }

    #[test]
    fn client_ttl_is_short_enough_to_follow_a_moved_endpoint() {
        assert!(CLIENT_TTL <= Duration::from_secs(600), "{CLIENT_TTL:?}");
        assert!(CLIENT_TTL >= Duration::from_secs(60), "{CLIENT_TTL:?}");
    }
}
