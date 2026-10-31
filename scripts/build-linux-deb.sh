#!/usr/bin/env bash
# Build Termigo Linux DEB with stamped Antigravity OAuth credentials.
set -euo pipefail

cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/.."

# Load .env.local so the Rust compile-time option_env!() can see them.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

echo "==> Ensuring dependencies..."
pnpm install --frozen-lockfile

echo "==> Building frontend and CLI..."
pnpm build:cli
pnpm build

echo "==> Building Tauri Linux DEB..."
pnpm exec tauri build --bundles deb

echo "==> Done. DEB should be under src-tauri/target/release/bundle/deb/"
