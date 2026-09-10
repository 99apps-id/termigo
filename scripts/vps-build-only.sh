#!/usr/bin/env bash
# vps-build-only.sh — Resume from pnpm install (Rust already installed)
set -euo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true

# ── pnpm ──────────────────────────────────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  echo "[pnpm] Installing via get.pnpm.io..."
  export PNPM_HOME="$HOME/.local/share/pnpm"
  mkdir -p "$PNPM_HOME"
  curl -fsSL https://get.pnpm.io/install.sh | env PNPM_HOME="$PNPM_HOME" sh -
  export PATH="$PNPM_HOME:$PATH"
  echo "[pnpm] Installed: $(pnpm --version)"
else
  echo "[pnpm] Already installed: $(pnpm --version)"
  PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  export PATH="$PNPM_HOME:$PATH"
fi

# ── Clone / update repo ──────────────────────────────────────────────────────
INSTALL_DIR="$HOME/apps/termigo"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "[git] Updating repo..."
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout main
  git pull origin main
  echo "[git] At commit: $(git rev-parse --short HEAD)"
else
  echo "[git] Cloning repo..."
  git clone https://github.com/99apps-id/termigo.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  echo "[git] Cloned at: $(git rev-parse --short HEAD)"
fi

cd "$INSTALL_DIR"

# ── Build ────────────────────────────────────────────────────────────────────
echo "[build] pnpm install..."
pnpm install --frozen-lockfile 2>&1 | tail -5

echo "[build] pnpm tauri build --no-bundle (this takes 10-15 min)..."
# CRITICAL: Must use pnpm tauri build --no-bundle NOT cargo build
# cargo build alone produces ~13MB binary WITHOUT embedded frontend assets,
# causing UI hydration failure that silently breaks the Telegram bot.
pnpm tauri build --no-bundle 2>&1 | grep -E "(Compiling termigo|Finished|Built application|warning\[E|error\[)" || true

BINARY="src-tauri/target/release/termigo"
if [[ ! -f "$BINARY" ]]; then
  echo "[build] FAILED: binary not found at $BINARY"
  exit 1
fi

SIZE=$(stat -c%s "$BINARY")
SIZE_MB=$(echo "scale=1; $SIZE/1048576" | bc)
echo "[build] Binary: ${SIZE_MB}MB"

# Size guard: healthy binary is 16MB+; 13MB = broken cargo-only build
if (( SIZE < 14000000 )); then
  echo "[build] ERROR: Binary ${SIZE_MB}MB is too small — frontend NOT embedded!"
  echo "[build] This is the broken 13MB pattern. Do NOT deploy this binary."
  exit 1
fi
echo "[build] Size OK (${SIZE_MB}MB >= 14MB threshold)"

# ── Install ──────────────────────────────────────────────────────────────────
DEST="/usr/local/bin/termigo"
if [[ -f "$DEST" ]]; then
  BACKUP="${DEST}.prev-$(date +%Y%m%d-%H%M%S)"
  sudo cp "$DEST" "$BACKUP"
  echo "[install] Backed up: $BACKUP"
fi
sudo cp "$BINARY" "$DEST"
sudo chmod +x "$DEST"
echo "[install] Installed $DEST"

# ── Service ──────────────────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/termigo.service"
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"

if [[ ! -f "$SERVICE_FILE" ]]; then
  echo "[service] Creating systemd service..."
  sudo tee "$SERVICE_FILE" > /dev/null <<SERVICE
[Unit]
Description=Termigo AI Terminal (headless)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$HOME
Environment="HOME=$HOME"
Environment="DISPLAY="
ExecStart=/usr/local/bin/termigo
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/termigo.log
StandardError=append:$LOG_DIR/termigo.log

[Install]
WantedBy=multi-user.target
SERVICE
  sudo systemctl daemon-reload
  sudo systemctl enable termigo
fi

echo "[service] Starting termigo..."
sudo systemctl restart termigo
sleep 3
systemctl status termigo --no-pager -l | head -15

echo ""
echo "=== Build and Deploy Complete ==="
echo "Binary size: ${SIZE_MB}MB"
echo "Logs: tail -f $LOG_DIR/termigo.log"
echo "Monitor Telegram: journalctl -u termigo -f"
