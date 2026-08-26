//! Extension manifest schema, Rust side.
//!
//! Mirrors the zod schema on the frontend. Small for v1: id, name, version,
//! optional metadata, permissions, and contribution declarations. The
//! frontend re-validates after `ext_read_manifest` because it has richer
//! typing for `contributes.*`.

use serde::{Deserialize, Serialize};

/// Validate an extension id (kebab-case / dotted, publisher-scoped). Examples:
/// `acme.my-integration`, `ilhamrisky.dracula-theme`.
///
/// Rules: ASCII lower, dot/dash/underscore, no leading dot, length 3-64.
/// Runs on every install so a hostile zip cannot escape `<root>/<id>/` via
/// something like `../evil`.
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.len() < 3 || id.len() > 64 {
        return Err("manifest.id must be 3-64 chars".into());
    }
    if id.starts_with('.') || id.ends_with('.') {
        return Err("manifest.id must not start or end with a dot".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err(
            "manifest.id may only contain lowercase letters, digits, dot, dash, underscore".into(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    /// Path to the JS entry point, relative to the extension root. Optional;
    /// theme/snippet packs are pure-declarative.
    #[serde(default)]
    pub main: Option<String>,
    /// Opt-in worker sandbox: run the extension module in a Web Worker instead
    /// of the main webview. Only "worker" is supported today. Preserved so the
    /// frontend can pick the worker path - without it the host would import the
    /// module in the main webview, where DOM / Tauri APIs are unavailable.
    #[serde(default)]
    pub sandbox: Option<String>,
    /// Glob-style permission strings; validated at runtime by the host API.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Free-form JSON. Frontend zod schema validates the inner shape.
    #[serde(default)]
    pub contributes: serde_json::Value,
    #[serde(default)]
    pub engines: Option<Engines>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engines {
    /// Semver requirement, e.g. `">=0.2.6"`. Missing means "any".
    /// Field is `tedi`, matching the frontend z-schema and the published
    /// manifest format; the old `termigo` name was never written.
    #[serde(default)]
    pub tedi: Option<String>,
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let m: Manifest =
            serde_json::from_str(text).map_err(|e| format!("manifest parse error: {e}"))?;
        validate_id(&m.id)?;
        if m.name.trim().is_empty() {
            return Err("manifest.name is required".into());
        }
        if m.version.trim().is_empty() {
            return Err("manifest.version is required".into());
        }
        Ok(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_id() {
        assert!(validate_id("../evil").is_err());
        assert!(validate_id(".foo").is_err());
        assert!(validate_id("Foo").is_err());
        assert!(validate_id("ok-id").is_ok());
        assert!(validate_id("acme.my-integration").is_ok());
    }

    #[test]
    fn preserves_sandbox_and_engines() {
        let text = r#"{
            "id": "termigo-pentest-kit",
            "name": "Test",
            "version": "1.0.0",
            "main": "dist/main.js",
            "sandbox": "worker",
            "permissions": ["panels:register"],
            "engines": { "tedi": ">=0.9.0" }
        }"#;
        let m = Manifest::parse(text).expect("parse");
        assert_eq!(m.sandbox.as_deref(), Some("worker"));
        assert_eq!(
            m.engines.as_ref().and_then(|e| e.tedi.as_deref()),
            Some(">=0.9.0"),
        );
        // Round-trips through serialization so `ext_list` still surfaces it.
        let out = serde_json::to_string(&m).expect("serialize");
        assert!(out.contains("\"sandbox\":\"worker\""));
        assert!(out.contains("\"tedi\":\">=0.9.0\""));
    }

    #[test]
    fn sandbox_is_null_when_absent_but_still_parses() {
        let text = r#"{ "id": "test-ext", "name": "X", "version": "1.0.0" }"#;
        let m = Manifest::parse(text).expect("parse");
        assert_eq!(m.sandbox.as_deref(), None);
        assert_eq!(m.engines.as_ref().and_then(|e| e.tedi.as_deref()), None);
    }
}
