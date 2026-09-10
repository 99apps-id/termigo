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

# --- guard: jangan memutus pekerjaan agent yang sedang berjalan ---
# Deploy stop service (untuk menimpa binary), yang menghentikan webview &
# konteks run aktif. Kalau agent sedang bekerja, deploy batal agar tidak
# memutus pekerjaan di tengah jalan (run terputus = "diam" / tidak selesai).
# `--force` menimpa guard (hanya untuk kasus mendesak).
FORCE=0
for a in "$@"; do [ "$a" = "--force" ] && FORCE=1; done

# Baca status agent dari kontrol server (termigo-cli status --json).
# Jalankan sebagai user pemilik app (admin), bukan root: kontrol server di
# 127.0.0.1:46443 hanya bisa diakses oleh user yang men-jalankan app, jadi
# di bawah sudo kita harus `runuser -u admin` supaya query berhasil.
AGENT_USER="${AGENT_USER:-admin}"
agent_status() {
  if [ -x "${APP_DIR}/termigo-cli" ]; then
    runuser -u "$AGENT_USER" -- "${APP_DIR}/termigo-cli" status --json 2>/dev/null \
      | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 | tr -d '[:space:]'
  fi
}

agent_status_busy() {
  local s
  s="$(agent_status)"
  case "$s" in
    thinking|streaming|awaiting-approval|running) return 0 ;;
  esac
  return 1
}

if ! agent_status_busy 2>/dev/null; then
  :
else
  if [ "$FORCE" = "1" ]; then
    log "⚠ agent sedang BERJALAN (status=$(agent_status)) — dipaksa lanjut via --force"
  else
    log "⛔ agent sedang BERJALAN (status=$(agent_status)). Deploy dibatalkan agar tidak memutus pekerjaan."
    log "   Tunggu selesai, atau jalankan ulang dengan --force untuk memaksa (tidak disarankan)."
    exit 2
  fi
fi

# --- select source binary (abaikan flag --force) ---
SRC=""
ARGS=()
for a in "$@"; do
  case "$a" in
    --build) SRC_BUILD=1 ;;
    --force) : ;;  # already handled by guard; skip as source
    *) ARGS+=("$a") ;;
  esac
done
if [ "${SRC_BUILD:-0}" = "1" ]; then
  log "Building new binary (pnpm tauri build --no-bundle) ..."
  ( cd "$APP_DIR" && export PATH="$APP_DIR/node_modules/.bin:$PATH" && pnpm tauri build --no-bundle )
  SRC="$TARGET_RELEASE"
elif [ "${#ARGS[@]}" -gt 0 ]; then
  SRC="${ARGS[0]}"
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
