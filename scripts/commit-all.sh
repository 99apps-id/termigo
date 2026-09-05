#!/usr/bin/env bash
set -euo pipefail

# Stage all changes
git add .

# Commit with detailed message
git commit -m "feat(sql,mcp,telegram): harden sql explorer, mcp deserialization, and telegram relay

- SQL Explorer: add list_sql_connections tool, connection name resolution in run_sql, execution status check, binary normalization, and in-chat SQL syntax card rendering
- MCP: resilient tool deserialization for nullable descriptions, support string and int JSON-RPC IDs, and reactive cache invalidation on server changes
- Telegram Bot: eliminate prompt echo with synchronous dispatch locking and origin fingerprinting
- UI: enhance contrast in light theme across explorer, terminal, stack, and shell overlays
- Documentation: update README.md, CHANGELOG.md, and ROADMAP.md for v0.9.8"
