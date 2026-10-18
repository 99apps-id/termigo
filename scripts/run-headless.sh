#!/bin/bash
# Headless launcher for Termigo on Linux servers without a physical display.
# Disables WebKit accelerated compositing to prevent Mesa llvmpipe software
# rasterizer busy-loops, and runs inside an isolated D-Bus session.
#
# Launcher ini menjalankan binary pinned di ${APP_DIR}/termigo
# (atau /usr/bin/termigo jika diinstall via deb/package manager).

set -euo pipefail

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1

# Plafon memori untuk tool build
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "${SCRIPT_DIR}")"

# Cari executable termigo:
# 1. Binary pinned di direktori instalasi
# 2. Binary di src-tauri/target/release
# 3. Binary sistem di /usr/bin/termigo atau /usr/local/bin/termigo
EXECUTABLE=""
if [ -x "${APP_DIR}/termigo" ]; then
  EXECUTABLE="${APP_DIR}/termigo"
elif [ -x "${APP_DIR}/src-tauri/target/release/termigo" ]; then
  EXECUTABLE="${APP_DIR}/src-tauri/target/release/termigo"
elif command -v termigo >/dev/null 2>&1; then
  EXECUTABLE="$(command -v termigo)"
else
  echo "Error: termigo executable tidak ditemukan di ${APP_DIR}/termigo maupun PATH!" >&2
  exit 1
fi

# Pastikan termigo-cli companion tersedia di sebelah executable jika ada di target/release
EXE_DIR="$(dirname "${EXECUTABLE}")"
if [ ! -f "${EXE_DIR}/termigo-cli" ]; then
  if [ -f "${APP_DIR}/src-tauri/target/release/termigo-cli" ]; then
    cp "${APP_DIR}/src-tauri/target/release/termigo-cli" "${EXE_DIR}/termigo-cli"
    chmod +x "${EXE_DIR}/termigo-cli"
  fi
fi

exec /usr/bin/xvfb-run -a -s '-screen 0 1024x768x24' /usr/bin/dbus-run-session "${EXECUTABLE}" "$@"
