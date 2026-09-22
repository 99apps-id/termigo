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
- Panel renderer with table list, SQL editor, and results grid.
- Commands: `/db:open`, `/db:describe`, `/db:export`.
- AI tools: `db_describe <path>`, `db_query <path> <sql>`.
- Settings entries for `maxRows` and `defaultDirectory`.

## Next steps

- Bundle `sql.js` and replace the skeleton `runQuery` / `describeDatabase` with real SQLite execution.
- Add support for remote databases via SSH tunnel (`ctx.ssh.openForward`) + native Rust `db_*` commands.
- Persist query history in `ctx.storage`.
- Add CSV/JSON export via `invoke:fs_write_file`.
