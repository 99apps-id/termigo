#!/usr/bin/env bash
# deploy-vps.sh — Deploy a new Termigo binary to VPS and restart the service.
# Usage: bash deploy-vps.sh [VPS_USER@VPS_HOST]
# Default host is read from TERMIGO_VPS env var.

set -euo pipefail

VPS="${1:-${TERMIGO_VPS:-}}"
if [[ -z "$VPS" ]]; then
  echo "Error: set TERMIGO_VPS env var or pass VPS_USER@VPS_HOST as first arg"
  exit 1
fi

BINARY="src-tauri/target/release/termigo"
REMOTE_PATH="/usr/local/bin/termigo"
SERVICE="termigo"

if [[ ! -f "$BINARY" ]]; then
  echo "Error: binary not found at $BINARY — run 'pnpm tauri build --no-bundle' first"
  exit 1
fi

SIZE=$(stat -c%s "$BINARY" 2>/dev/null || stat -f%z "$BINARY")
echo "📦 Binary: $BINARY (${SIZE} bytes)"

echo "🚀 Uploading to $VPS:$REMOTE_PATH ..."
# Upload with a .new suffix to avoid replacing the running binary mid-flight
scp "$BINARY" "$VPS:/tmp/termigo.new"

echo "🔄 Installing on VPS ..."
ssh "$VPS" bash -s <<'REMOTE'
set -euo pipefail
SERVICE=termigo
REMOTE_PATH=/usr/local/bin/termigo

# Back up the current binary with timestamp
if [[ -f "$REMOTE_PATH" ]]; then
  BACKUP="${REMOTE_PATH}.prev-$(date +%Y%m%d-%H%M%S)"
  cp "$REMOTE_PATH" "$BACKUP"
  echo "  ✓ Backup: $BACKUP"
fi

# Stop service
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  systemctl stop "$SERVICE"
  echo "  ✓ Service stopped"
fi

# Swap binary
mv /tmp/termigo.new "$REMOTE_PATH"
chmod +x "$REMOTE_PATH"
echo "  ✓ Binary installed"

# Start service
systemctl start "$SERVICE"
sleep 2
systemctl status "$SERVICE" --no-pager -l
REMOTE

echo ""
echo "✅ Deploy complete. Verifying Telegram bot is active..."
ssh "$VPS" bash -s <<'VERIFY'
sleep 3
if ss -tnp | grep -q "termigo.*:443"; then
  echo "✓ Telegram connection established (port 443)"
else
  echo "⚠ No port 443 connection yet — bot may still be starting"
fi
journalctl -u termigo -n 20 --no-pager 2>/dev/null || true
VERIFY
