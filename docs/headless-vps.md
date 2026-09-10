# Headless VPS Deployment Guide

Deploy Termigo on a headless Linux server (Ubuntu/Debian) as a 24/7 AI agent relay controlled via Telegram.

---

## 1. Prerequisites

Install the required system dependencies for Tauri and virtual headless display:

```bash
sudo apt update && sudo apt install -y \
  xvfb \
  dbus \
  libgtk-3-0 \
  libwebkit2gtk-4.1-0 \
  libayatana-appindicator3-1 \
  librsvg2-common \
  libglib2.0-0
```

> **Note:** `libgtk-3-dev` and `libwebkit2gtk-4.1-dev` are **not** needed at runtime unless you rebuild from source on the same VPS. For deployment-only, runtime packages above are sufficient.

---

## 2. Build & Assembly

From the Termigo repository root on the server:

```bash
# Install Node dependencies
pnpm install

# Build CLI companion + frontend + Rust binary (all-in-one via Tauri)
# This runs: pnpm build:cli && pnpm build (frontend) then compiles Rust.
# Do NOT use raw "cargo build" — it skips the frontend bundle step.
pnpm tauri build --no-bundle

# Place executables in application root
cp src-tauri/target/release/termigo ./termigo
cp src-tauri/target/release/termigo-cli ./termigo-cli
chmod +x ./termigo ./termigo-cli scripts/run-headless.sh
```

> **Important:** Always use `pnpm tauri build --no-bundle` (or `scripts/deploy-termigo.sh --build`) to build Termigo. Raw `cargo build --release` skips the frontend bundle and produces a 13MB binary that cannot serve the UI or connect to Telegram.

### Health check before deploying

A healthy Termigo binary for headless VPS should be **16–48 MB** (includes embedded frontend assets). A broken build is typically **13 MB** (Rust-only, no assets). Verify size and connectivity before replacing the running binary:

```bash
# Check binary size
ls -lh ./termigo

# Quick connectivity test (headless)
xvfb-run -a -s "-screen 0 1024x768x24" dbus-run-session ./termigo &
sleep 5
termigo-cli status --json   # should show "ui": "idle" or "ui": "thinking"
termigo-cli identify        # should return space info, not "still restoring its workspace"
ss -tnp | grep 149.154.166.110 || ss -tnp | grep api.telegram.org
kill %1 2>/dev/null
```

> **Rollback tip:** Always keep the current working binary as a timestamped backup before overwriting:
> ```bash
> cp /opt/termigo/termigo /opt/termigo/termigo.prev-$(date +%Y%m%d-%H%M%S)
> ```

---

## 3. Deployment & Service

Place the binary in `/opt/termigo/` and install the systemd service:

```bash
# Stop existing service
sudo systemctl stop termigo

# Backup current binary for rollback
cp /opt/termigo/termigo /opt/termigo/termigo.prev-$(date +%Y%m%d-%H%M%S)

# Deploy new binary
cp ./termigo /opt/termigo/termigo
chmod +x /opt/termigo/termigo

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart termigo
sudo systemctl enable --now termigo
```

### Checking Status & Logs

```bash
sudo systemctl status termigo
sudo journalctl -u termigo -f --since "5 minutes ago"
```

### Verify Telegram connectivity

```bash
# Should show ESTAB to Telegram API
ss -tnp | grep termigo

# Should return valid session info (not "still restoring its workspace")
termigo-cli identify

# Should show populated UI and valid model ID
termigo-cli status --json
```

---

## 4. Configuration & Credentials

Termigo stores its data in `~/.local/share/id.99apps.termigo/`.

### A. Telegram Token (OS Keyring)

The Telegram bot token is stored in the OS keyring (`termigo-telegram`), **not** in `secrets.json`. To set or rotate the token:

```bash
# Set token via keyring (interactive)
secret-tool store --label="termigo-telegram" termigo telegram-token

# Or via termigo-cli if available
termigo-cli set-telegram-token "<YOUR_TELEGRAM_BOT_TOKEN>"
```

To find the paired chat ID after first `/pair`:

```bash
termigo-cli status --json | jq '.telegram.chatId'
```

> **Note:** On first run without an owner configured, send `/pair <TELEGRAM_USER_ID>` from your Telegram chat to lock the bot to your account.

### B. Settings (`termigo-settings.json`)

Place your custom model endpoints, providers, and agent preferences in `termigo-settings.json`. Critical fields:

- `defaultModelId`: Must match an ID present in `customEndpoints`. If this references a missing model, the workspace hydration will fail and Telegram will not respond.
- `customEndpoints`: Array of `{ id, label, provider, baseURL, apiKey, ... }` for each model endpoint.

```json
{
  "defaultModelId": "15292c18",
  "customEndpoints": [
    {
      "id": "15292c18",
      "label": "deepseek-v4-flash",
      "provider": "deepseek",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "<REDACTED>"
    }
  ]
}
```

### C. Multi-User Setup

By default, the bot responds to the paired chat only. To allow multiple Telegram users/threads with isolated sessions:

1. Unpair the bot: send `/unpair` from the paired chat (requires owner user ID match).
2. Any chat can now interact with the bot.
3. Each `chatId` (and `message_thread_id` for forum topics) gets its own isolated agent session.
4. Session metadata is stored in `~/.local/share/id.99apps.termigo/termigo-spaces.json`.

---

## 5. Headless Launcher (`run-headless.sh`)

The [`scripts/run-headless.sh`](file:///scripts/run-headless.sh) script wraps the binary with:

- `xvfb-run`: virtual framebuffer for WebKit GTK
- `dbus-run-session`: isolated D-Bus session for system tray/notification APIs
- Environment variables:
  - `WEBKIT_DISABLE_COMPOSITING_MODE=1`: Disables accelerated 3D compositing, preventing Mesa llvmpipe software rasterizer busy-loops on systems without a hardware GPU.
  - `WEBKIT_DISABLE_DMABUF_RENDERER=1`: Prevents DMA-BUF renderer errors in virtual framebuffers.

The systemd service uses this launcher by default.

---

## 6. Troubleshooting

### Bot not responding after deploy

1. Check binary size: `ls -lh /opt/termigo/termigo` — must be ≥ 16 MB.
2. Check logs: `journalctl -u termigo -n 50` — look for GTK panic, workspace hydration failure, or missing assets.
3. Verify Telegram connection: `ss -tnp | grep 149.154.166.110` — if empty, token may be invalid or workspace hydration failed.
4. Check `defaultModelId` in `termigo-settings.json` — must exist in `customEndpoints`.
5. Rollback if needed: `cp /opt/termigo/termigo.prev-TIMESTAMP /opt/termigo/termigo && systemctl restart termigo`

### "still restoring its workspace"

The `defaultModelId` in `termigo-settings.json` references a model ID not present in `customEndpoints`. Fix by either:
- Adding the missing model to `customEndpoints`, or
- Updating `defaultModelId` to a valid ID from `customEndpoints`.

### Step cap / approval hangs

- `/continue` now validates: steer queue empty, agent not busy, run not stopped by user.
- Auto-continue respects `agentAutoContinue` preference and `stopLatch`.
- Approval queue is cleared on `/stop` and fresh user messages.

### Workspace hydration failure

Causes: invalid `defaultModelId`, corrupted data directory, or mismatched binary. Fix order:
1. Restore `termigo-settings.json` from backup or fix `defaultModelId`.
2. If still failing, restore data directory from `~/.local/share/id.99apps.termigo/.bak`.
3. If still failing, rollback binary to last known-good backup.

---

## 7. Maintenance

### Updating Termigo

```bash
cd /opt/termigo
git pull --rebase
pnpm install
pnpm tauri build --no-bundle
sudo systemctl stop termigo
cp src-tauri/target/release/termigo /opt/termigo/termigo
sudo systemctl start termigo
```

### Watchdog

The watchdog script (`scripts/termigo-watchdog.sh`) monitors service health and auto-restarts on failure. Enable via cron if desired:

```bash
(crontab -l 2>/dev/null; echo "*/2 * * * * /opt/termigo/scripts/termigo-watchdog.sh") | crontab -
```

### Backup

Regularly back up:
- `/opt/termigo/termigo.prev-*` (binary rollback chain)
- `~/.local/share/id.99apps.termigo/` (settings, sessions, secrets)
- `/etc/systemd/system/termigo.service` (service unit)
