//! One version, four manifests.
//!
//! F-5 of the 2026-09-23 deep audit: `Cargo.toml` said 0.9.15 while
//! `tauri.conf.json` said 0.9.19 and `package.json` said 0.9.18 — the
//! installer advertised a version the shipped binary did not carry, and the
//! updater compared against a number no manifest agreed on. Aligning them once
//! is not enough; the same shape of guard as `command_authorization.rs` keeps
//! them aligned: this test fails CI the moment any manifest drifts.

use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

fn cargo_versions() -> Vec<String> {
    let text = std::fs::read_to_string(repo_root().join("src-tauri/Cargo.toml"))
        .expect("read src-tauri/Cargo.toml");
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            l.strip_prefix("version = \"")
                .and_then(|rest| rest.strip_suffix('"'))
                .map(str::to_string)
        })
        .collect()
}

fn json_version(rel: &str) -> String {
    let text = std::fs::read_to_string(repo_root().join(rel))
        .unwrap_or_else(|e| panic!("read {rel}: {e}"));
    // Deliberately not a JSON parse: the top-level "version" is the first
    // occurrence in both manifests, and pulling in a JSON dependency for one
    // field is not worth it in an integration test.
    let mut at = 0;
    while let Some(rel_idx) = text[at..].find('"') {
        let idx = at + rel_idx;
        let rest = &text[idx..];
        if let Some(v) = rest
            .strip_prefix("\"version\"")
            .and_then(|r| r.trim_start().strip_prefix(':'))
            .and_then(|r| r.trim_start().strip_prefix('"'))
        {
            if let Some(end) = v.find('"') {
                return v[..end].to_string();
            }
        }
        at = idx + 1;
    }
    panic!("no top-level \"version\" found in {rel}");
}

#[test]
fn every_manifest_carries_the_same_version() {
    let tauri_conf = json_version("src-tauri/tauri.conf.json");
    let pkg = json_version("package.json");
    let npm_shim = json_version("npm/termigo/package.json");
    let cargos = cargo_versions();

    assert!(
        cargos.len() >= 2,
        "expected the termigo package version and the workspace version in \
         src-tauri/Cargo.toml, found {cargos:?}"
    );
    for v in &cargos {
        assert_eq!(
            *v, tauri_conf,
            "src-tauri/Cargo.toml version drifted from tauri.conf.json \
             (the number the installer and updater advertise)"
        );
    }
    assert_eq!(
        pkg, tauri_conf,
        "package.json version drifted from tauri.conf.json"
    );
    assert_eq!(
        npm_shim, tauri_conf,
        "npm/termigo/package.json version drifted from tauri.conf.json"
    );
}
