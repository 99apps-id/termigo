#!/bin/bash
# Headless launcher for Termigo on Linux servers without a physical display.
# Disables WebKit accelerated compositing to prevent Mesa llvmpipe software
# rasterizer busy-loops, and runs inside an isolated D-Bus session.

set -euo pipefail

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "${SCRIPT_DIR}")"

# Pick the freshest termigo build: prefer a binary just produced by
# `pnpm tauri build` (src-tauri/target/release/termigo) when it is newer than
# a manually copied app-root binary, so the next restart picks up a rebuild
# automatically instead of running a stale copy.
ROOT_BIN="${APP_DIR}/termigo"
TARGET_BIN="${APP_DIR}/src-tauri/target/release/termigo"
EXECUTABLE=""
if [ -x "${TARGET_BIN}" ] && [ -x "${ROOT_BIN}" ]; then
  if [ "${TARGET_BIN}" -nt "${ROOT_BIN}" ]; then
    EXECUTABLE="${TARGET_BIN}"
  else
    EXECUTABLE="${ROOT_BIN}"
  fi
elif [ -x "${ROOT_BIN}" ]; then
  EXECUTABLE="${ROOT_BIN}"
elif [ -x "${TARGET_BIN}" ]; then
  EXECUTABLE="${TARGET_BIN}"
else
  echo "Error: termigo executable not found in ${APP_DIR}" >&2
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
