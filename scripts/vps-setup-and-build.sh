#!/usr/bin/env bash
# vps-setup-and-build.sh
# Run on VPS to clone repo, install deps, and build Termigo headless binary.
# Usage: bash vps-setup-and-build.sh [GITHUB_REPO_URL]
# Default: https://github.com/99apps-id/termigo.git
set -euo pipefail

REPO="${1:-https://github.com/99apps-id/termigo.git}"
INSTALL_DIR="$HOME/apps/termigo"
SERVICE_NAME="termigo"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LOG_DIR="$HOME/logs"
SETTINGS_DIR="$HOME/.config/termigo"

echo "=== Termigo VPS Setup ==="
echo "Repo: $REPO"
echo "Install dir: $INSTALL_DIR"
echo ""

# ── 1. System dependencies ──────────────────────────────────────────────────
echo "[1/7] Installing system deps..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  curl git build-essential pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf \
  ca-certificates unzip 2>&1 | grep -E "^(Get|Setting|Preparing|Unpacking|E:)" || true
echo "  ✓ System deps done"

# ── 2. Rust ─────────────────────────────────────────────────────────────────
if ! command -v cargo &>/dev/null; then
  echo "[2/7] Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  source "$HOME/.cargo/env"
  echo "  ✓ Rust $(rustc --version)"
else
  echo "[2/7] Rust already installed: $(rustc --version)"
  source "$HOME/.cargo/env" 2>/dev/null || true
fi

# ── 3. Node / pnpm ──────────────────────────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  echo "[3/7] Installing pnpm (via corepack, no root needed)..."
  # corepack is bundled with Node >= 16. Enable it and activate pnpm.
  if command -v corepack &>/dev/null; then
    corepack enable pnpm 2>/dev/null || true
    corepack prepare pnpm@latest --activate 2>&1 | tail -3
  fi
  # Fallback: install standalone pnpm to $HOME/.local/bin
  if ! command -v pnpm &>/dev/null; then
    export PNPM_HOME="$HOME/.local/share/pnpm"
    mkdir -p "$PNPM_HOME"
    curl -fsSL https://get.pnpm.io/install.sh | env PNPM_HOME="$PNPM_HOME" sh -
    export PATH="$PNPM_HOME:$PATH"
  fi
  echo "  ✓ pnpm $(pnpm --version)"
else
  echo "[3/7] pnpm already installed: $(pnpm --version)"
  # Ensure PNPM_HOME is on PATH for standalone installs
  PNPM_HOME="$HOME/.local/share/pnpm"
  if [[ -d "$PNPM_HOME" ]]; then
    export PATH="$PNPM_HOME:$PATH"
  fi
fi

# ── 4. Clone / update repo ──────────────────────────────────────────────────
echo "[4/7] Cloning/updating repo..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout main
  git pull origin main
  echo "  ✓ Updated to $(git rev-parse --short HEAD)"
else
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  echo "  ✓ Cloned at $(git rev-parse --short HEAD)"
fi

# ── 5. Build ─────────────────────────────────────────────────────────────────
echo "[5/7] Installing JS deps..."
pnpm install --frozen-lockfile 2>&1 | tail -5
echo "  ✓ pnpm install done"

echo "[5/7] Building Termigo (this takes 5-15 min on first run)..."
# MUST use pnpm tauri build --no-bundle, NOT cargo build directly.
# cargo build alone produces a 13MB binary WITHOUT embedded frontend assets,
# causing UI hydration failure that silently breaks the Telegram bot.
pnpm tauri build --no-bundle 2>&1 | grep -E "(Compiling termigo|Finished|Built application|error\[|warning\[|FAILED)" || true

BINARY="src-tauri/target/release/termigo"
if [[ ! -f "$BINARY" ]]; then
  echo "ERROR: Build failed — binary not found at $BINARY"
  exit 1
fi

BINARY_SIZE=$(stat -c%s "$BINARY")
BINARY_MB=$(echo "scale=1; $BINARY_SIZE/1048576" | bc)
echo "  ✓ Built: $BINARY_MB MB"

# Sanity check: a healthy binary should be > 14 MB (includes embedded frontend).
# A broken cargo-only binary is ~13 MB and lacks Vite assets.
if (( BINARY_SIZE < 14000000 )); then
  echo "WARNING: Binary size ${BINARY_MB}MB is suspiciously small."
  echo "  A healthy Termigo binary should be ~16MB+."
  echo "  This may indicate the frontend was not embedded."
  echo "  Re-run with: pnpm tauri build --no-bundle"
  exit 1
fi
echo "  ✓ Binary size OK (${BINARY_MB}MB ≥ 14MB threshold)"

# ── 6. Install binary ───────────────────────────────────────────────────────
echo "[6/7] Installing binary..."
DEST="/usr/local/bin/termigo"
if [[ -f "$DEST" ]]; then
  BACKUP="${DEST}.prev-$(date +%Y%m%d-%H%M%S)"
  sudo cp "$DEST" "$BACKUP"
  echo "  ✓ Backup saved: $BACKUP"
fi
sudo cp "$BINARY" "$DEST"
sudo chmod +x "$DEST"
echo "  ✓ Installed to $DEST"

# ── 7. Systemd service ──────────────────────────────────────────────────────
echo "[7/7] Setting up systemd service..."
mkdir -p "$LOG_DIR" "$SETTINGS_DIR"

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
Environment="XDG_RUNTIME_DIR=/run/user/$(id -u)"
ExecStart=/usr/local/bin/termigo
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/termigo.log
StandardError=append:$LOG_DIR/termigo.log

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

# ── Verify settings before start ─────────────────────────────────────────────
# A custom endpoint's model id in the app is the synthetic `compat-<endpoint id>`
# form. A hand-written config usually carries the bare endpoint id (or the
# endpoint name / model id) instead, which the app cannot resolve, so it fell
# back to a default model with no key - the bot answered nothing. The helper
# accepts all forms, rewrites the file to the stored form, and fails only when
# the id genuinely matches nothing.
SETTINGS_FILE="$SETTINGS_DIR/termigo-settings.json"
MODEL_ID_CHECKER="$(dirname "$0")/check-settings-model-id.py"
if [[ -f "$SETTINGS_FILE" && -f "$MODEL_ID_CHECKER" ]]; then
  echo ""
  echo "Checking termigo-settings.json defaultModelId..."
  SETTINGS_CHECK=$(python3 "$MODEL_ID_CHECKER" "$SETTINGS_FILE" 2>&1)
  SETTINGS_STATUS=$?
  echo "  $SETTINGS_CHECK"

  if [[ $SETTINGS_STATUS -ne 0 ]]; then
    echo ""
    echo "✗ Refusing to start: defaultModelId cannot be resolved."
    echo "  Set it to one of the ids listed above, then re-run this script."
    exit 1
  fi
fi

echo ""
echo "Starting termigo service..."
sudo systemctl start "$SERVICE_NAME"
sleep 3
systemctl status "$SERVICE_NAME" --no-pager -l | head -20

echo ""
echo "Checking Telegram connection (port 443)..."
sleep 5
if ss -tnp 2>/dev/null | grep -q "149.154\|91.108"; then
  echo "✓ Telegram connection established"
else
  echo "⚠ No Telegram connection yet — may still be starting. Check: journalctl -u termigo -f"
fi

echo ""
echo "=== Setup Complete ==="
echo "Binary: $(termigo --version 2>/dev/null || echo 'use: termigo-cli identify')"
echo "Logs:   tail -f $LOG_DIR/termigo.log"
echo "Status: systemctl status termigo"
