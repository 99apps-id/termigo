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
#      plus snapshot data dir -> termigo.prev-data-<ts>.tgz. Store aplikasi hidup
#      di luar binary, jadi rollback yang hanya memulihkan binary menjalankan
#      build lama di atas data bentuk-baru dan kehilangan settings.
#   2. salin binary baru ke /opt/termigo/termigo (pinned)
#   3. restart service
#   4. smoke-test: tunggu webview boot penuh (memory >= THRESH) + ada ESTAB/SYN ke api.telegram.org
#   5. kalau GAGAL -> restore binary + data prev -> restart -> exit 1
#   6. kalau OK -> hapus binary rusak yg tersisa, simpan known-good copy, exit 0

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_HEADLESS="${APP_DIR}/scripts/run-headless.sh"
PINNED="${APP_DIR}/termigo"
KNOWN_GOOD="${APP_DIR}/termigo.known-good"
TARGET_RELEASE="${APP_DIR}/src-tauri/target/release/termigo"

SERVICE="termigo.service"
UTH=70000000       # memory threshold: minimal webview "boot penuh" (~70MB bytes)
POLL_TIMEOUT=90     # detik maksimal tunggu boot + koneksi
SLEEP_UNIT=8        # interval poll

# --- helpers ---
mem_bytes() { systemctl show "$SERVICE" -p MemoryCurrent --value; }
has_tg_conn() { ss -tnp 2>/dev/null | grep -E "149\\.154|2001:67c" | grep -qE "WebKitNetworkPr|termigo"; }
is_healthy() {
  if [ -x "${APP_DIR}/termigo-cli" ]; then
    runuser -u "$AGENT_USER" -- "${APP_DIR}/termigo-cli" ping 2>/dev/null | grep -q "is running" && return 0
  fi
  has_tg_conn
}
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

# --- data dir yang harus ikut di-backup ---
# Store aplikasi (settings, sessions, trajectory, secrets, local storage webview)
# hidup DI SINI, bukan di sebelah binary. Rollback yang hanya memulihkan binary
# menjalankan build lama di atas data yang sudah ditulis ulang build baru dalam
# bentuk yang tidak dikenali build lama - hasilnya settings hilang, bukan
# kembali. Karena itu snapshot diambil bersama binary dan dipulihkan bersamanya.
# Alamat diambil dari home user pemilik app; bisa dioverride lewat DATA_DIR.
DATA_DIR="${DATA_DIR:-}"
if [ -z "$DATA_DIR" ]; then
  U_HOME="$(getent passwd "$AGENT_USER" 2>/dev/null | cut -d: -f6)"
  DATA_DIR="${U_HOME:-/home/$AGENT_USER}/.local/share/id.99apps.termigo"
fi
log "Data dir: $DATA_DIR"

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

# Snapshot data dir SETELAH service berhenti. Itu satu-satunya saat yang
# konsisten (tidak ada penulis di tengah flush) sekaligus saat terakhir data
# masih berbentuk seperti yang ditulis build lama - tepat yang dibutuhkan
# rollback. Ditaruh sebelum binary baru disalin, jadi build baru belum sempat
# menyentuh apa pun.
DATA_BACKUP=""
if [ -d "$DATA_DIR" ]; then
  DATA_BACKUP="${APP_DIR}/termigo.prev-data-${TS}.tgz"
  if tar czf "$DATA_BACKUP" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" 2>/dev/null; then
    log "Backup data dir -> $DATA_BACKUP ($(stat -c %s "$DATA_BACKUP") bytes)"
  else
    rm -f "$DATA_BACKUP"; DATA_BACKUP=""
    log "WARN: backup data dir GAGAL - rollback nanti hanya memulihkan binary"
  fi
else
  log "Data dir belum ada - tidak ada data untuk di-backup"
fi

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
  T="no"
  is_healthy && T="yes"
  log "  poll#$((i+1)) mem=${M} healthy=${T}"
  if [ "${M:-0}" -ge "$UTH" ] && is_healthy; then PASS=1; break; fi
done

# --- 5. rollback kalau gagal ---
if [ "$PASS" -ne 1 ]; then
  log "!!! Smoke-test GAGAL - rollback ke binary + data sebelumnya"
  if [ -f "$BACKUP" ]; then
    cp -p "$BACKUP" "$PINNED"
    log "Restore $PINNED dari $BACKUP"
  else
    # ya tidak ada backup? fallback ke known-good
    [ -f "$KNOWN_GOOD" ] && { cp -p "$KNOWN_GOOD" "$PINNED"; log "Restore dari $KNOWN_GOOD"; }
  fi
  # Store dipulihkan SEBELUM build lama dijalankan, supaya build lama tidak
  # pernah membaca data bentuk-baru. Diekstrak menimpa isi yang ada (bukan
  # mengganti direktori), jadi berkas yang tidak ada di snapshot tetap bertahan.
  if [ -n "$DATA_BACKUP" ] && [ -f "$DATA_BACKUP" ]; then
    if tar xzf "$DATA_BACKUP" -C "$(dirname "$DATA_DIR")" 2>/dev/null; then
      log "Restore data dir dari $DATA_BACKUP"
    else
      log "WARN: restore data dir GAGAL - pulihkan manual dari $DATA_BACKUP"
    fi
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
# Snapshot data sengaja DISIMPAN setelah sukses: itu satu-satunya salinan
# bentuk-lama. Hapus manual setelah versi baru terbukti stabil.
[ -n "$DATA_BACKUP" ] && log "Snapshot data (simpan sampai versi baru terbukti): $DATA_BACKUP"
log "DONE."
