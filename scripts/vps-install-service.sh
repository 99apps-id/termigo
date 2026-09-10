#!/usr/bin/env bash
# vps-install-service.sh — Install termigo systemd service with Xvfb (virtual display)
# Run on VPS as user naracitrasolusindo (sudo access required)
set -euo pipefail

LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"

echo "=== Installing Termigo systemd service (with Xvfb) ==="

# ── Ensure Xvfb is installed ──────────────────────────────────────────────────
if ! command -v Xvfb &>/dev/null; then
  echo "Installing Xvfb..."
  sudo apt-get install -y xvfb
fi
echo "  ✓ Xvfb: $(Xvfb -version 2>&1 | head -1)"

# ── Create wrapper script ─────────────────────────────────────────────────────
WRAPPER="/usr/local/bin/termigo-headless"
sudo tee "$WRAPPER" > /dev/null << 'WRAPPER_EOF'
#!/usr/bin/env bash
# Wrapper: start Xvfb virtual display, then launch Termigo
set -euo pipefail

DISPLAY_NUM=99
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"

# Kill any existing Xvfb on display :99
pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
sleep 0.5

# Start Xvfb virtual framebuffer (1024x768x24)
Xvfb ":${DISPLAY_NUM}" -screen 0 1024x768x24 -nolisten tcp &
XVFB_PID=$!
echo "[Xvfb] Started PID=$XVFB_PID on :${DISPLAY_NUM}"

# Wait for display to be ready
sleep 1

export DISPLAY=":${DISPLAY_NUM}"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GDK_BACKEND=x11
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"

echo "[termigo] Starting with DISPLAY=$DISPLAY"
exec /usr/local/bin/termigo
WRAPPER_EOF

sudo chmod +x "$WRAPPER"
echo "  ✓ Wrapper: $WRAPPER"

# ── Create systemd service ────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/termigo.service"
USER_ID=$(id -u)

sudo tee "$SERVICE_FILE" > /dev/null << SERVICE
[Unit]
Description=Termigo AI Terminal (headless with Xvfb)
After=network-online.target dbus.service
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$HOME
Environment="HOME=$HOME"
Environment="DISPLAY=:99"
Environment="WEBKIT_DISABLE_COMPOSITING_MODE=1"
Environment="GDK_BACKEND=x11"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${USER_ID}/bus"
ExecStartPre=/usr/bin/Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
ExecStart=$WRAPPER
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=120
StartLimitBurst=3
StandardOutput=append:$LOG_DIR/termigo.log
StandardError=append:$LOG_DIR/termigo.log

[Install]
WantedBy=multi-user.target
SERVICE

# Better approach: separate Xvfb service + termigo depends on it
sudo tee /etc/systemd/system/xvfb-termigo.service > /dev/null << 'XVFB_SVC'
[Unit]
Description=Xvfb virtual display for Termigo
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1024x768x24 -nolisten tcp
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
XVFB_SVC

# Rewrite termigo service to depend on Xvfb service
sudo tee "$SERVICE_FILE" > /dev/null << SERVICE
[Unit]
Description=Termigo AI Terminal (headless)
After=network-online.target xvfb-termigo.service
Wants=network-online.target xvfb-termigo.service
Requires=xvfb-termigo.service

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$HOME
Environment="HOME=$HOME"
Environment="DISPLAY=:99"
Environment="WEBKIT_DISABLE_COMPOSITING_MODE=1"
Environment="GDK_BACKEND=x11"
Environment="XDG_RUNTIME_DIR=/run/user/${USER_ID}"
ExecStartPre=/bin/sleep 2
ExecStart=/usr/local/bin/termigo
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5
StandardOutput=append:$LOG_DIR/termigo.log
StandardError=append:$LOG_DIR/termigo.log

[Install]
WantedBy=multi-user.target
SERVICE

echo "  ✓ Service files written"

# ── Enable and start ──────────────────────────────────────────────────────────
sudo systemctl daemon-reload

echo "Starting Xvfb service..."
sudo systemctl enable xvfb-termigo
sudo systemctl start xvfb-termigo
sleep 2
systemctl is-active xvfb-termigo && echo "  ✓ Xvfb running"

echo "Starting Termigo service..."
sudo systemctl enable termigo
sudo systemctl start termigo
sleep 4

systemctl status termigo --no-pager -l | head -20

echo ""
echo "Checking Telegram connection (10s)..."
sleep 10
if ss -tnp 2>/dev/null | grep -qE "149\.154|91\.108"; then
  echo "✅ Telegram connected!"
else
  echo "⚠ Checking process..."
  pidof termigo && echo "  Process running" || echo "  No process"
  tail -20 "$LOG_DIR/termigo.log" 2>/dev/null
fi

echo ""
echo "=== Done ==="
echo "Monitor: journalctl -u termigo -f"
echo "Logs: tail -f $LOG_DIR/termigo.log"
