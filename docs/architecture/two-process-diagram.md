# Two-process architecture (mermaid)

Diagram versi visual dari [two-process model](two-process-model.md) dan `TERMIGO.md`.

## Arsitektur keseluruhan

```mermaid
flowchart TB
    subgraph FW["Frontend process (Webview) - React 19 + TS + xterm.js"]
        direction LR
        UI["UI modules<br/>terminal / editor / explorer / tabs / ai / git / ssh / lsp"]
        WRAP["Typed command wrappers<br/>modules/*/lib"]
        UI --> WRAP
    end

    subgraph IPC["IPC boundary - Tauri invoke()"]
        INV["invoke('cmd', args)"]
        CAP["Capability allowlist<br/>capabilities/default.json"]
        CHAN["Channel&lt;PtyEvent&gt;<br/>streaming output, never one big payload"]
    end

    subgraph BK["Backend process (Rust) - Tauri 2 + portable-pty"]
        direction LR
        H["#[tauri::command] handlers<br/>registered in src-tauri/src/lib.rs"]
        G["Boundary guards<br/>workspace auth registry / deny-list / SSRF guard / approval flow"]
        H --> G
        G --> PTY["pty::*  open/write/resize/close"]
        G --> FS["fs::*  file / search / grep / mutate / watch"]
        G --> GIT["git::*  status/diff/stage/commit"]
        G --> SH["shell::*  run_command / session / bg"]
        G --> LSP["lsp::*  spawn/send/kill"]
        G --> AI["ai::* + net::*  HTTP proxy (SSRF guard)"]
        G --> SEC["secrets::*  OS keychain"]
        G --> SSH["ssh::*  open/write/sftp"]
        G --> WS["workspace::*  authorize / current_dir / wsl"]
    end

    subgraph OS["OS resources - owned exclusively by Rust"]
        O1["PTY / ConPTY shell spawn"]
        O2["Filesystem"]
        O3["Git binaries"]
        O4["Subprocesses + LSP servers"]
        O5["Network / provider APIs"]
        O6["OS keychain (keyring crate)"]
    end

    WRAP -->|"request"| INV
    INV --> CAP
    CAP --> H
    H -->|"async events"| CHAN
    CHAN --> UI
    PTY --> O1
    FS --> O2
    GIT --> O3
    SH --> O4
    LSP --> O4
    AI --> O5
    SSH --> O5
    SEC --> O6
```

## Alur session PTY (data stream)

```mermaid
sequenceDiagram
    participant UI as React (xterm.js)
    participant R as Rust backend
    participant S as shell (portable-pty / ConPTY)

    UI->>R: invoke("pty_open", {cmd, cwd, cols, rows})
    R->>S: spawn_command (shell init, OSC 7 + OSC 133)
    R-->>UI: ok(id)
    R-->>UI: Channel<PtyEvent> (data / exit / agent-signal)
    UI->>UI: xterm.write(parsed data)
    UI->>R: invoke("pty_write", {id, data})
    R->>S: write bytes to PTY
    UI->>R: invoke("pty_resize", {id, cols, rows})
    R->>S: resize PTY
    UI->>R: invoke("pty_close", {id})
    R->>S: kill (Job Object / group-kill, never just the child)
    R-->>UI: ok (cleanup)
```

## Invariant yang dijaga

- Webview **tidak pernah** menyentuh FS, proses, atau shell secara langsung; semua lewat `invoke()` ke command yang terdaftar.
- Command baru harus didaftarkan di `lib.rs` **dan** di-guard di boundary (workspace auth, deny-list, SSRF, approval flow).
- Plugin API yang dipakai webview harus ada di `capabilities/default.json`, atau tidak ada.
- Input tak tepercaya (escape sequence terminal, isi file, hasil tool AI) di-parse dan divalidasi di Rust, tidak dieksekusi oleh renderer.
- Output panjang (PTY, log) mengalir lewat `Channel`, bukan dikembalikan sekaligus.
