#!/bin/bash
# Deploy build Termigo baru DENGAN smoke-test otomatis + rollback.
#
# Cara pakai (opsional build via --build):
#   ./scripts/deploy-termigo.sh              # deploy binary yg sudah ada di src-tauri/target/release/termigo
#   ./scripts/deploy-termigo.sh --build      # build dulu (tauri build --no-bundle) lalu deploy
#   ./scripts/deploy-termigo.sh /path/binary # deploy binary tertentu
#
# Alur:
#   1. backup binary yang sedang dipakai -> termigo.prev-<ts>
#   2. salin binary baru ke /opt/termigo/termigo (pinned)
#   3. restart service
#   4. smoke-test: tunggu webview boot penuh (memory >= THRESH) + ada ESTAB/SYN ke api.telegram.org
#   5. kalau GAGAL -> restore binary prev -> restart -> exit 1
#   6. kalau OK -> hapus binary rusak yg tersisa, simpan known-good copy, exit 0

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_HEADLESS="${APP_DIR}/scripts/run-headless.sh"
PINNED="${APP_DIR}/termigo"
KNOWN_GOOD="${APP_DIR}/termigo.known-good"
TARGET_RELEASE="${APP_DIR}/src-tauri/target/release/termigo"

SERVICE="termigo.service"
UTH=300000          # memory threshold: minimal webview "boot penuh" (bytes). 89MB = fail, 300MB+ = pass
POLL_TIMEOUT=90     # detik maksimal tunggu boot + koneksi
SLEEP_UNIT=8        # interval poll

# --- helpers ---
mem_bytes() { systemctl show "$SERVICE" -p MemoryCurrent --value; }
has_tg_conn() { ss -tnp 2>/dev/null | grep -E "149\\.154|2001:67c" | grep -qE "WebKitNetworkPr|termigo"; }
log() { echo "[deploy-termigo] $*"; }

# --- select source binary ---
SRC=""
if [ "${1:-}" = "--build" ]; then
  log "Building new binary (tauri build --no-bundle) ..."
  ( cd "$APP_DIR" && export PATH="$APP_DIR/node_modules/.bin:$PATH" && npx tauri build --no-bundle )
  SRC="$TARGET_RELEASE"
  shift
elif [ -n "${1:-}" ]; then
  SRC="$1"; shift
elif [ -f "$TARGET_RELEASE" ]; then
  SRC="$TARGET_RELEASE"
else
  log "ERROR: tidak ada binary sumber. Gunakan --build, path binary, atau bangun dulu." >&2
  exit 2
fi

[ -x "$SRC" ] || { log "ERROR: sumber tidak executable: $SRC" >&2; exit 2; }
log "Sumber binary: $SRC"

# --- 1. backup pinned yang sedang dipakai ---
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="${APP_DIR}/termigo.prev-${TS}"
if [ -f "$PINNED" ]; then
  cp -p "$PINNED" "$BACKUP"
  log "Backup binary berjalan -> $BACKUP"
fi

# --- 2. stop service (biar file bisa ditimpa) lalu salin binary baru ke pinned ---
log "Stop $SERVICE (agar binary tidak Text-file-busy) ..."
sudo systemctl stop "$SERVICE" || true
sleep 2
cp -p "$SRC" "$PINNED"
chmod +x "$PINNED"
log "Salin binary baru -> $PINNED ($(stat -c %s "$PINNED") bytes)"

# --- 3. start kembali ---
log "Start $SERVICE ..."
sudo systemctl start "$SERVICE"

# --- 4. smoke-test ---
log "Smoke-test: tunggu webview boot penuh (mem>=${UTH}) + koneksi Telegram (max ${POLL_TIMEOUT}s)"
PASS=0
for (( i=0; i<POLL_TIMEOUT/SLEEP_UNIT; i++ )); do
  sleep "$SLEEP_UNIT"
  M="$(mem_bytes)"
  T="y2"
  has_tg_conn && T="y"
  log "  poll#$((i+1)) mem=${M} conn=${T}"
  if [ "${M:-0}" -ge "$UTH" ] && has_tg_conn; then PASS=1; break; fi
done

# --- 5. rollback kalau gagal ---
if [ "$PASS" -ne 1 ]; then
  log "!!! Smoke-test GAGAL - rollback ke binary sebelumnya"
  if [ -f "$BACKUP" ]; then
    cp -p "$BACKUP" "$PINNED"
    log "Restore $PINNED dari $BACKUP"
  else
    # ya tidak ada backup? fallback ke known-good
    [ -f "$KNOWN_GOOD" ] && { cp -p "$KNOWN_GOOD" "$PINNED"; log "Restore dari $KNOWN_GOOD"; }
  fi
  sudo systemctl restart "$SERVICE"
  log "Rollback selesai. Service sedang reloading."
  exit 1
fi

# --- 6. sukses: update known-good & bersihkan ---
cp -p "$PINNED" "$KNOWN_GOOD"
log "Smoke-test LULUS. known-good diperbarui."
log "Sisa binary backup (lihat di $APP_DIR/termigo.prev-*):"
ls -1 "${APP_DIR}"/termigo.prev-* 2>/dev/null | tail -5 || true
log "DONE."
