#!/bin/bash
# Watchdog Termigo: deteksi aplikasi yang HIDUP tetapi macet (webview bisu),
# lalu restart; kalau tetap macet setelah N percobaan, rollback ke known-good.
#
# Kenapa ini perlu walau unit sudah Restart=always: systemd hanya menangani
# proses yang KELUAR. Kegagalan nyata di lapangan adalah proses yang tetap hidup
# sementara webview berhenti menjawab, sehingga relay Telegram mati diam-diam
# selama jam-an (terukur: 9 jam, NRestarts=0). systemd tidak melihat apa pun.
#
# Dipasang sebagai systemd timer, lihat docs/headless-vps.md.
# Exit: 0 = sehat atau sudah di-restart, 1 = sudah rollback, 2 = gagal.

set -uo pipefail

APP_DIR="/opt/termigo"
SERVICE="termigo.service"
CLI="${APP_DIR}/termigo-cli"
PINNED="${APP_DIR}/termigo"
KNOWN_GOOD="${APP_DIR}/termigo.known-good"
STATE_DIR="${APP_DIR}/.watchdog"
STATE_FILE="${STATE_DIR}/restarts"
LOG_FILE="${STATE_DIR}/watchdog.log"

MAX_RESTARTS=3
# Ambang RSS aplikasi yang boot penuh. Ini juga yang menangkap boot yang tidak
# pernah selesai; versi sebelumnya memakai 300000 byte (300 KB), yang selalu
# terlewati sehingga tidak menyaring apa pun.
THRESH_BYTES=262144000
# Jangan menilai selama boot: aplikasi headless butuh puluhan detik sebelum
# webview siap, dan menilai terlalu cepat menghasilkan restart beruntun.
GRACE_SECS=120
STATUS_TIMEOUT=25
LOG_MAX_LINES=2000

mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date +%F_%T)" "$*" >> "$LOG_FILE"; }

# Batasi berkas log. Versi sebelumnya menulis ke /tmp/termigo-watchdog.last dan
# meng-append selamanya.
trim_log() {
  local n
  n=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "${n:-0}" -gt "$LOG_MAX_LINES" ]; then
    tail -n "$((LOG_MAX_LINES / 2))" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi
}

is_active() { systemctl is-active --quiet "$SERVICE"; }

memory_bytes() {
  systemctl show "$SERVICE" -p MemoryCurrent --value 2>/dev/null || echo 0
}

# Lama aplikasi berjalan, dalam detik (0 bila tidak terbaca).
uptime_secs() {
  local started now
  started=$(systemctl show "$SERVICE" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo 0)
  now=$(awk '{printf "%d", $1 * 1000000}' /proc/uptime 2>/dev/null || echo 0)
  if [ "${started:-0}" -le 0 ] || [ "${now:-0}" -le 0 ]; then echo 0; return; fi
  echo $(( (now - started) / 1000000 ))
}

# Sehat = webview menjawab control plane DAN RSS menunjukkan boot penuh.
#
# Control plane dipakai, bukan `ss | grep telegram`, karena socket Telegram tidak
# selalu ada: long-poll memutus lalu menyambung lagi, jadi snapshot bisa kosong
# pada relay yang sehat - itu memicu restart palsu pada versi sebelumnya.
# `status --json` menjawab {"ok":true,...,"ui":{...}} selama webview hidup, dan
# menjawab frontend_timeout tepat pada kegagalan yang harus ditangkap.
healthy() {
  local out bytes
  out=$(timeout "$STATUS_TIMEOUT" "$CLI" status --json 2>/dev/null) || return 1
  case "$out" in
    *'"ui":{'*) ;;
    *'"ui": {'*) ;;
    *) return 1 ;;
  esac
  bytes=$(memory_bytes)
  [ "${bytes:-0}" -ge "$THRESH_BYTES" ]
}

restart_service() { sudo systemctl restart "$SERVICE"; }

trim_log

if ! is_active; then
  log "service DOWN -> restart"
  restart_service
  exit 0
fi

UP=$(uptime_secs)
if [ "${UP:-0}" -lt "$GRACE_SECS" ]; then
  log "grace: baru jalan ${UP}s, dilewati (mem=$(memory_bytes))"
  exit 0
fi

if healthy; then
  echo 0 > "$STATE_FILE"
  log "OK mem=$(memory_bytes)"
  exit 0
fi

COUNT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
case "$COUNT" in ''|*[!0-9]*) COUNT=0 ;; esac
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"
log "UNHEALTHY count=$COUNT mem=$(memory_bytes) -> restart"

if [ "$COUNT" -ge "$MAX_RESTARTS" ]; then
  if [ -f "$KNOWN_GOOD" ]; then
    cp -p "$KNOWN_GOOD" "$PINNED"
    log "rollback: dipulihkan dari $KNOWN_GOOD"
  else
    log "rollback dilewati: $KNOWN_GOOD tidak ada (wajib dibuat saat rilis)"
  fi
  restart_service
  echo 0 > "$STATE_FILE"
  exit 1
fi

restart_service
exit 0