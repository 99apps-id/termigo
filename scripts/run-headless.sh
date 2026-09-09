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
