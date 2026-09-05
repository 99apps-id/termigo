# PowerShell commit script for Termigo
$ErrorActionPreference = "Stop"

git add .
git commit -m "feat(sql,mcp,telegram): harden sql explorer, mcp deserialization, and telegram relay`n`n- SQL Explorer: add list_sql_connections tool, connection name resolution in run_sql, execution status check, binary normalization, and in-chat SQL syntax card rendering`n- MCP: resilient tool deserialization for nullable descriptions, support string and int JSON-RPC IDs, and reactive cache invalidation on server changes`n- Telegram Bot: eliminate prompt echo with synchronous dispatch locking and origin fingerprinting`n- UI: enhance contrast in light theme across explorer, terminal, stack, and shell overlays`n- Documentation: update README.md, CHANGELOG.md, and ROADMAP.md for v0.9.8"
