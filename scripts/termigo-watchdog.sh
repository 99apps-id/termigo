#!/bin/bash
# Watchdog bot Termigo: cek polling Telegram masih hidup; kalau mati -> restart,
# kalau tetap mati setelah N percobaan -> rollback ke known-good.
# Dijalankan via cron (lihat crontab admin). Exit code: 0 = OK, 1 = sudah restore, 2 = gagal total.

set -uo pipefail

APP_DIR="/opt/termigo"
SERVICE="termigo.service"
KNOWN_GOOD="${APP_DIR}/termigo.known-good"
PINNED="${APP_DIR}/termigo"
STATE_DIR="${APP_DIR}/.watchdog"
STATE_FILE="${STATE_DIR}/restarts"
MAX_RESTARTS=3         # max restart beruntun sebelum rollback
THRESH_BYTES=300000    # memori minimal "boot penuh"
MARK="/tmp/termigo-watchdog.last"
mkdir -p "$STATE_DIR"

# --- helper cek sehat: boot penuh + ada koneksi telegram ---
healthy() {
  local M
  M="$(systemctl show "$SERVICE" -p MemoryCurrent --value 2>/dev/null || echo 0)"
  ss -tnp 2>/dev/null | grep -E "149\\.154|2001:67c" | grep -qE "WebKitNetworkPr|termigo" && \
    [ "${M:-0}" -ge "$THRESH_BYTES" ]
}

# --- cek service aktif ---
is_active() { systemctl is-active --quiet "$SERVICE"; }

# catat waktu & status ke mark (untuk dek observasi)
echo "$(date +%F_%T) active=$(is_active && echo yes || echo no) conn=$(ss -tnp 2>/dev/null | grep -E "149\\.154|2001:67c" | grep -qE "WebKitNetworkPr|termigo" && echo yes || echo no)" >> "$MARK"

if ! is_active; then
  echo "watchdog: SERVICE DOWN, restart" >> "$MARK"
  sudo systemctl restart "$SERVICE"
  exit 0
fi

if healthy; then
  # reset counter kalau sehat
  echo 0 > "$STATE_FILE"
  echo "watchdog: OK $(date +%T)" >> "$MARK"
  exit 0
fi

# service aktif tapi polling/ boot mati -> restart
COUNT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
COUNT=$((COUNT+1))
echo "$COUNT" > "$STATE_FILE"
echo "watchdog: UNHEALTHY count=$COUNT, restart service $(date +%T)" >> "$MARK"
sudo systemctl restart "$SERVICE"

if [ "$COUNT" -ge "$MAX_RESTARTS" ]; then
  echo "watchdog: restart ${COUNT}x gagal -> ROLLBACK ke known-good $(date +%T)" >> "$MARK"
  [ -f "$KNOWN_GOOD" ] && { cp -p "$KNOWN_GOOD" "$PINNED"; echo "watchdog: restored $PINNED" >> "$MARK"; }
  sudo systemctl restart "$SERVICE"
  echo 0 > "$STATE_FILE"
  exit 1
fi

exit 0
