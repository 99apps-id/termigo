#!/usr/bin/env bash
# vps-run-build.sh — Run from VPS directly. Assumes pnpm/cargo already installed.
set -euo pipefail

PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME/bin:$HOME/.cargo/bin:$PATH"

echo "Tools:"
echo "  pnpm: $(pnpm --version 2>/dev/null || echo MISSING)"
echo "  cargo: $(cargo --version 2>/dev/null || echo MISSING)"
echo "  node: $(node --version 2>/dev/null || echo MISSING)"

cd "$HOME/apps/termigo"
echo "Repo: $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"

echo ""
echo "[1] pnpm install..."
pnpm install --frozen-lockfile 2>&1 | tail -8

echo ""
echo "[2] pnpm tauri build --no-bundle (10-15 min)..."
# MUST use pnpm tauri build --no-bundle, NOT cargo build.
# cargo build = 13MB broken binary without frontend assets.
pnpm tauri build --no-bundle 2>&1

echo ""
BINARY="src-tauri/target/release/termigo"
SIZE=$(stat -c%s "$BINARY")
SIZE_MB=$(echo "scale=1; $SIZE / 1048576" | bc)
echo "Binary: $BINARY = ${SIZE_MB}MB"

if (( SIZE < 14000000 )); then
  echo "ERROR: ${SIZE_MB}MB < 14MB — frontend NOT embedded. Broken binary, abort."
  exit 1
fi
echo "Size OK: ${SIZE_MB}MB (expected ~16MB)"

echo ""
echo "[3] Installing binary..."
DEST="/usr/local/bin/termigo"
if [[ -f "$DEST" ]]; then
  sudo cp "$DEST" "${DEST}.prev-$(date +%Y%m%d-%H%M%S)"
fi
sudo cp "$BINARY" "$DEST"
sudo chmod +x "$DEST"
echo "Installed: $DEST"

echo ""
echo "[4] Setting up and starting service..."
sudo tee /etc/systemd/system/termigo.service > /dev/null << 'SVCEOF'
[Unit]
Description=Termigo AI Terminal (headless)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=naracitrasolusindo
WorkingDirectory=/home/naracitrasolusindo
Environment="HOME=/home/naracitrasolusindo"
Environment="DISPLAY="
ExecStart=/usr/local/bin/termigo
Restart=on-failure
RestartSec=5
StandardOutput=append:/home/naracitrasolusindo/logs/termigo.log
StandardError=append:/home/naracitrasolusindo/logs/termigo.log

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable termigo
sudo systemctl restart termigo
sleep 4
systemctl status termigo --no-pager -l | head -20

echo ""
echo "=== DONE ==="
echo "Tail: tail -f $HOME/logs/termigo.log"
echo "Telegram check:"
sleep 5
ss -tnp 2>/dev/null | grep -E "termigo.*(149\.154|91\.108)" || echo "  No Telegram connection yet (may still be starting)"
journalctl -u termigo -n 10 --no-pager 2>/dev/null || true
