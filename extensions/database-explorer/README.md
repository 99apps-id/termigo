# Database Explorer

Skeleton extension for Termigo that opens SQLite files in a sidebar-driven query workspace.

## Install (dev)

```bash
cd extensions/database-explorer
zip -r ../database-explorer.zip .
```

Then in Termigo:
1. Open Settings → Extensions.
2. Install from file → choose `../database-explorer.zip`.
3. Accept the requested permissions.

## What it demonstrates

- Sidebar section for recent SQLite files.
- Host-managed panel (HTML template) with query editor and results grid.
- Commands: `/db:open`, `/db:describe`, `/db:export`.
- AI tools: `db_describe <path>`, `db_query <path> <sql>`.
- Settings: `maxRows`, `defaultDirectory`.
- Storage: `recentFiles` persisted.

## sql.js bundling

This extension bundles **sql.js** (SQLite compiled to WebAssembly) directly inside the package so it works offline:

```
extensions/database-explorer/
  manifest.json
  main.js
  README.md
  lib/
    sql-wasm.js    ← sql.js loader (classic script, loaded via new Function)
    sql-wasm.b64   ← base64-encoded SQLite WASM binary
```

At activation time, `main.js`:

1. Reads `lib/sql-wasm.js` via `ext_read_asset`.
2. Loads it into the worker global scope with `new Function(...)` so `initSqlJs` becomes available.
3. Reads `lib/sql-wasm.b64` via `ext_read_asset`.
4. Decodes the base64 string to a `Uint8Array` and passes it to `initSqlJs({ wasmBinary })`.

This avoids any core changes: both files are plain text assets, and `ext_read_asset` already supports reading them.

## Sandbox compatibility

The panel uses a **host-managed HTML template** (`panel.setView`) instead of a DOM-manipulating renderer. This keeps the extension working in Termigo's sandboxed worker mode.

Events are routed back through `data-ext-event` attributes and `panel.on(...)` handlers.

## Roadmap

- Real binary file reading for `.db` files (requires `fs_read_file` to return raw bytes or a new `fs_read_file_binary` command).
- Directory picker for recent files.
- Export query results to CSV/JSON.
- Remote database support (Postgres/MySQL via native Rust commands or sidecar).
