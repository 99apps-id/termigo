fn main() {
    // The window/app icon is embedded by tauri-build from the icons folder;
    // declare them as inputs so changing the logo actually re-links the
    // binary (cargo otherwise caches the old resource).
    if let Ok(entries) = std::fs::read_dir("icons") {
        for entry in entries.flatten() {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
    }
    configure_sidecar();
    stamp_env_local();
    tauri_build::build()
}

fn configure_sidecar() {
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let path =
        std::path::PathBuf::from("binaries").join(format!("termigo-cli-{target}{extension}"));
    let valid =
        std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0);
    if valid {
        return;
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        panic!(
            "release sidecar {} is missing or empty; run pnpm build:cli before packaging",
            path.display()
        );
    }

    let mut config = std::env::var("TAURI_CONFIG")
        .map(|value| serde_json::from_str(&value).expect("parse TAURI_CONFIG"))
        .unwrap_or_else(|_| serde_json::json!({}));
    config["bundle"]["externalBin"] = serde_json::json!([]);
    std::env::set_var(
        "TAURI_CONFIG",
        serde_json::to_string(&config).expect("serialize TAURI_CONFIG"),
    );
}

fn stamp_env_local() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let path = root.join(".env.local");
    // Emitting any rerun-if-changed disables cargo's default package-wide
    // tracking, and a build script that does not rerun replays its previous
    // rustc-env output. Without this line, editing .env.local leaves the old
    // Antigravity pair baked into the binary until an unrelated rebuild.
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-env-changed=TERMIGO_ANTIGRAVITY_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=TERMIGO_ANTIGRAVITY_CLIENT_SECRET");

    let mut client_id = std::env::var("TERMIGO_ANTIGRAVITY_CLIENT_ID")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let mut client_secret = std::env::var("TERMIGO_ANTIGRAVITY_CLIENT_SECRET")
        .ok()
        .filter(|v| !v.trim().is_empty());

    if let Ok(contents) = std::fs::read_to_string(&path) {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut iter = line.splitn(2, '=');
            let Some(key) = iter.next() else { continue };
            let Some(raw_value) = iter.next() else {
                continue;
            };
            let value = raw_value.trim_matches('"').trim_matches('\'').trim();
            if value.is_empty() {
                continue;
            }
            match key {
                "TERMIGO_ANTIGRAVITY_CLIENT_ID" if client_id.is_none() => {
                    client_id = Some(value.to_string());
                }
                "TERMIGO_ANTIGRAVITY_CLIENT_SECRET" if client_secret.is_none() => {
                    client_secret = Some(value.to_string());
                }
                _ => {}
            }
        }
    }

    if let Some(value) = client_id {
        println!("cargo:rustc-env=TERMIGO_ANTIGRAVITY_CLIENT_ID={value}");
    }
    if let Some(value) = client_secret {
        println!("cargo:rustc-env=TERMIGO_ANTIGRAVITY_CLIENT_SECRET={value}");
    }
}
