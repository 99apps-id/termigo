# Headless VPS Deployment Guide

This guide explains how to deploy Termigo on a headless Linux server (Ubuntu/Debian) running 24/7 as an AI agent relay controlled via Telegram.

---

## 1. Prerequisites

Install the required system dependencies for Tauri and virtual headless display:

```bash
sudo apt update && sudo apt install -y \
  xvfb \
  dbus \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1 \
  librsvg2-common
```

---

## 2. Build & Assembly

From the Termigo repository root on the server:

```bash
# Install Node dependencies
pnpm install

# Build CLI companion + frontend + Rust binary (all-in-one via Tauri)
# This runs: pnpm build:cli && pnpm build (frontend) then compiles Rust.
# Do NOT use raw "cargo build" - it skips the frontend bundle step.
pnpm tauri build --no-bundle

# Place executables in application root
cp src-tauri/target/release/termigo ./termigo
cp src-tauri/target/release/termigo-cli ./termigo-cli
chmod +x ./termigo ./termigo-cli scripts/run-headless.sh
```

> **Important:** Always use `pnpm tauri build --no-bundle` (or `scripts/deploy-termigo.sh --build`)
> to build Termigo. Raw `cargo build --release` skips the frontend bundle and produces a
> binary that cannot serve the UI - Telegram bot will not respond.

---

## 3. Configuration & Credentials

Termigo stores its data in `~/.local/share/id.99apps.termigo/`:

### A. Secrets (`secrets.json`)
Set permissions to `chmod 600 secrets.json`:
```json
{
  "termigo-telegram::token": "<YOUR_TELEGRAM_BOT_TOKEN>",
  "termigo-telegram::owner": "<YOUR_NUMERIC_TELEGRAM_USER_ID>",
  "termigo-ai::deepseek-api-key": "<API_KEY>",
  "termigo-ai::openai-api-key": "<API_KEY>"
}
```

> **Note:** Providing `termigo-telegram::owner` allows the bot to auto-enable upon boot without requiring an interactive GUI window, and restricts all incoming commands exclusively to the specified owner ID.

### B. Settings (`termigo-settings.json`)
Place your custom model endpoints, providers, and agent preferences in `termigo-settings.json`.

---

## 4. Systemd Service

Install the service unit from [`scripts/termigo.service`](file:///scripts/termigo.service):

```bash
sudo cp scripts/termigo.service /etc/systemd/system/termigo.service
sudo systemctl daemon-reload
sudo systemctl enable --now termigo
```

### Checking Status & Logs:
```bash
sudo systemctl status termigo
sudo journalctl -u termigo -f
```

---

## 5. Performance Optimizations in Headless Mode

The [`scripts/run-headless.sh`](file:///scripts/run-headless.sh) launcher script automatically configures:
- `WEBKIT_DISABLE_COMPOSITING_MODE=1`: Disables accelerated 3D compositing, preventing Mesa llvmpipe software rasterizer busy-loops on systems without a hardware GPU.
- `WEBKIT_DISABLE_DMABUF_RENDERER=1`: Prevents DMA-BUF renderer errors in virtual framebuffers.
- `dbus-run-session`: Wraps the virtual Xvfb display in an isolated D-Bus session, eliminating missing session bus errors.
