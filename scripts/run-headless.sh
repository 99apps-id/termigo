#!/bin/bash
# Headless launcher for Termigo on Linux servers without a physical display.
# Disables WebKit accelerated compositing to prevent Mesa llvmpipe software
# rasterizer busy-loops, and runs inside an isolated D-Bus session.
#
# ==== PENGAMAN (2026-09-09) ====
# Launcher ini TIDAK lagi otomatis memilih binary termuda dari
# src-tauri/target/release/termigo. Alasan: build rusak dapat langsung
# menimpa binary yang bekerja saat restart -> webview gagal boot -> bot mati.
#
# Sekarang launcher SELALU menjalankan binary pinned di ${APP_DIR}/termigo
# (path yang sama dengan `binaries/termigo-cli` companion). Update hanya
# dipakai bila deploy script memindahkan binary ke sini SETELAH lolos
# smoke-test (lihat scripts/deploy-termigo.sh). Build di
# src-tauri/target/release/ tidak pernah otomatis dipakai.

set -euo pipefail

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1

# ==== Plafon memori untuk tool build (2026-09-13) ====
# Batas memori unit berlaku untuk SELURUH pohon proses, jadi build apa pun yang
# dijalankan dari dalam relay - termasuk yang dijalankan agent lewat tool shell
# atau PTY - dibebankan ke kuota aplikasi (MemoryHigh). Terukur: build node +
# rustc mendorong cgroup ke 2.0GB, sehingga webview ter-throttle dan berhenti
# menjawab, dan relay Telegram mati diam-diam sepanjang malam.
#
# Kedua variabel ini diwarisi oleh shell PTY dan perintah agent, dan keduanya
# mengekang konsumen terbesarnya tanpa melarang build: heap V8 dibatasi, dan
# paralelisme rustc dikunci ke 1 (build rilis paralel sudah pernah di-OOM-kill
# di kotak ini). Operator masih bisa menimpanya kalau memang perlu ruang lebih.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"

# ==== Arena malloc glibc (2026-09-13, EKSPERIMEN) ====
# WebKitWebProcess menjalankan ~20 thread, dan glibc membuat satu arena malloc
# per thread (dibatasi 8 x jumlah core). Setiap arena memegang free-list-nya
# sendiri dan TIDAK mengembalikannya ke OS, jadi RSS berhenti di lantai tinggi
# walau beban sudah turun - terukur: webview 870MB saat idle, sementara isi
# transkrip yang aktif hanya ~1MB.
#
# Diuji murni sebagai eksperimen: kalau lantai memori idle tidak turun setelah
# restart, hapus dua baris ini. Tidak ada yang bergantung padanya.
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "${SCRIPT_DIR}")"

# Binary pinned (known-good). Hanya deploy script yang menimpa file ini.
EXECUTABLE="${APP_DIR}/termigo"

if [ ! -x "${EXECUTABLE}" ]; then
  echo "Error: pinned termigo executable not found: ${EXECUTABLE}" >&2
  exit 1
fi

# Ensure termigo-cli companion exists next to main executable
EXE_DIR="$(dirname "${EXECUTABLE}")"
if [ ! -f "${EXE_DIR}/termigo-cli" ]; then
  if [ -f "${APP_DIR}/src-tauri/target/release/termigo-cli" ]; then
    cp "${APP_DIR}/src-tauri/target/release/termigo-cli" "${EXE_DIR}/termigo-cli"
    chmod +x "${EXE_DIR}/termigo-cli"
  fi
fi

exec /usr/bin/xvfb-run -a -s '-screen 0 1024x768x24' /usr/bin/dbus-run-session "${EXECUTABLE}" "$@"
