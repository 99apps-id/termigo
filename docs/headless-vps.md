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
# Do NOT use raw "cargo build" - it skips the frontend bundle step.
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

Place the binary in `/opt/termigo/` and install the systemd service.

### 3.1 systemd unit

The repo ships `scripts/termigo.service`. Install it as `/etc/systemd/system/termigo.service`:

```ini
[Unit]
Description=Termigo Headless AI Telegram Relay
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/opt/termigo
ExecStart=/opt/termigo/scripts/run-headless.sh
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536
MemoryHigh=2G
MemoryMax=2560M

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp /opt/termigo/scripts/termigo.service /etc/systemd/system/termigo.service
```

### 3.2 Binary deployment

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

### A. Telegram Token (secret store)

The bot token is stored by the app under service `termigo-telegram`, account `token`, and **never** in `termigo-settings.json`.

Where that resolves depends on the platform, and the difference matters on a headless box:

| Platform | Store |
| --- | --- |
| Linux (this guide) | `secrets.json` in the data dir, an object keyed `"service::account"`, mode `0600` |
| macOS / Windows | the OS keychain (`secrets_get` / `secrets_set`) |

So on the VPS the token is the `"termigo-telegram::token"` entry of `~/.local/share/id.99apps.termigo/secrets.json`. `secret-tool` is **not** read by the app on Linux, and the bundled `termigo-cli` has no token command: set the token from the app (Settings, Telegram) or by writing that entry while the service is stopped, then restart it.

Owner pairing is separate state. Sending `/pair` from the chat locks the bot to that account (it takes no argument) and is stored as relay state in the webview's `localStorage` key `termigo-telegram` (`chatId` plus `ownerUserId`), not in the settings file. A `termigo-telegram::owner` entry in the secret store is only a seed, applied on startup when the relay state has no owner yet.

To check that the relay is actually talking to Telegram, do not ask `status`: it reports the app, agent and workspace, and carries no Telegram fields. Use the socket and the relay log:

```bash
# One established connection to Telegram (IPv4 and/or IPv6) while the bot is up
ss -tnp | grep -i telegram || ss -tnp | grep 149.154
# The relay logs each update, run, stall and poll failure
grep -i telegram ~/.local/share/id.99apps.termigo/logs/Termigo.log | tail -20
```

> **Note:** Without an owner configured, `/pair` from your Telegram chat locks the bot to that account. Run it once; afterwards only that account may start runs or answer approvals.

### B. Settings (`termigo-settings.json`)

Place your custom model endpoints and agent preferences in `termigo-settings.json` (in the data directory above).

**How a model id works.** An OpenAI-compatible endpoint is addressed by a synthetic model id built from its endpoint id:

```
customEndpoints[].id = "15292c18"   ->   defaultModelId = "compat-15292c18"
```

`defaultModelId` must be `compat-<customEndpoints[].id>` for a custom endpoint, or a built-in registry id (e.g. `gpt-5.4-mini`). Writing the bare endpoint id, the endpoint's `name`, or its `modelId` also works - the app and the setup script translate it - but `compat-<id>` is what gets stored, so use that form and avoid surprises.

**Fields.** `customEndpoints` entries have exactly these keys:

| Field | Meaning |
| --- | --- |
| `id` | Your internal id for the endpoint (`compat-` ids are derived from it). |
| `name` | Display name, e.g. `DeepSeek`. |
| `baseURL` | OpenAI-compatible base URL, e.g. `https://api.deepseek.com/v1`. |
| `modelId` | The model id the provider itself expects, e.g. `deepseek-flash`. |
| `contextLimit` | Context window in tokens, e.g. `1000000`. |

There is no `label`, `provider` or `apiKey` field: the label is `name`, the provider is always `openai-compatible`, and keys belong in the OS keychain, never in this file.

```json
{
  "defaultModelId": "compat-15292c18",
  "customEndpoints": [
    {
      "id": "15292c18",
      "name": "DeepSeek",
      "baseURL": "https://api.deepseek.com/v1",
      "modelId": "deepseek-flash",
      "contextLimit": 1000000
    }
  ]
}
```

Set the endpoint's key in the keychain (Settings → Models, or `secrets_set`); the file above only names the model.

**Editing settings without the window.** The Go companion in `cli/` can read and change the allowlisted settings over the running app's control socket, which is easier than editing JSON by hand:

```bash
go build -o termigo ./cli/cmd/termigo      # not installed by the app; build it on the host
./termigo settings                         # defaultModelId, agentApprovalMode, toolSearchEnabled, groups
./termigo model deepseek-v4-pro            # set the default model
./termigo approval ask                     # confirm every edit before it runs
./termigo tui                              # the same, interactive
```

These go through the same setters the Settings window uses, so the value is validated and normalised in one place. Writable keys are exactly `defaultModelId`, `toolSearchEnabled`, `disabledToolGroups` and `agentApprovalMode`; anything else is refused by the app with the reason. The bundled `termigo-cli` (the Rust helper next to the app binary) does not have these commands.

**Renamed models.** If a provider renames a model, change `modelId` here (or Settings → Models → *Model IDs*) rather than the app. For a built-in provider such as DeepSeek, Settings exposes a per-model override for the same purpose.

Run `scripts/vps-setup-and-build.sh` after editing: it rewrites a legacy `defaultModelId` into the `compat-<id>` form and refuses to start the service when the id cannot be resolved, which is the usual cause of "the bot is up but never replies".

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

1. Check binary size: `ls -lh /opt/termigo/termigo` - must be at least 16 MB (a healthy build is ~47 MB).
2. Ask the app whether it is alive at all: `/opt/termigo/termigo-cli status --json`. A non-null `"ui"` means the webview is up; `frontend_timeout` (or no `ui`) means it is wedged or never booted, which no amount of Telegram debugging will fix.
3. Check logs: `journalctl -u termigo -n 50` and `grep -ai telegram ~/.local/share/id.99apps.termigo/logs/Termigo.log | tail -20` - look for GTK panic, workspace hydration failure, missing assets, `polling stalled`, or a `409 Conflict`.
4. Do NOT judge the relay by `ss -tnp | grep 149.154`: long-poll disconnects between requests, so a healthy relay can show no socket at that instant, and other tenants on this box hold their own Telegram sockets. The relay log is the reliable signal.
5. Check `defaultModelId` in `termigo-settings.json` - for a custom endpoint it must be `compat-<customEndpoints[].id>`, and the endpoint's key must be in the keychain. `scripts/vps-setup-and-build.sh` rewrites a bare endpoint id and refuses to start on an unresolvable one.
6. Rollback if needed: `sudo systemctl stop termigo && cp /opt/termigo/termigo.bak-TIMESTAMP /opt/termigo/termigo && sudo systemctl start termigo`. Keep `termigo.known-good` pointed at a build you trust; the watchdog rolls back to it on its own after repeated failures.

### "still restoring its workspace"

The `defaultModelId` in `termigo-settings.json` does not resolve to a runnable model. Fix by either:
- Setting it to `compat-<customEndpoints[].id>` (or a built-in registry id such as `gpt-5.4-mini`), or
- Adding the missing endpoint to `customEndpoints` and setting the key for it.

A bare endpoint id, the endpoint `name` and its `modelId` are all accepted and rewritten to the `compat-<id>` form, but if nothing matches, the app falls back to a built-in model that has no key - which is why the bot starts but never answers.

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

Do NOT rebuild while the relay is running. The agent's own build steps run inside
the service cgroup, so their memory is charged to the app's `MemoryHigh`, which is
how a field install wedged its webview and went silent for 9 hours. Stop the
service first: that both narrows the memory the build can use and removes the
contention.

```bash
sudo systemctl stop termigo
cd /opt/termigo
git pull --ff-only
# CARGO_BUILD_JOBS=1: this box OOM-killed a parallel release build before.
CARGO_BUILD_JOBS=1 pnpm tauri build --no-bundle

# Health check BEFORE deploying: a binary without the frontend assets is ~13 MB
# instead of ~47 MB, and it boots to a blank window that never answers.
ls -l src-tauri/target/release/termigo

cp -a termigo "termigo.bak-$(date +%s)"
cp -f src-tauri/target/release/termigo termigo
sudo systemctl start termigo
sleep 30
systemctl is-active termigo                 # active
/opt/termigo/termigo-cli status --json      # must show a non-null "ui"
```

`status --json` returning `frontend_timeout` (no `ui`) means the webview did not
come up: the binary is not a good one, or the app was starved of memory. Restore
the previous binary rather than leaving a silent relay running.

### Watchdog

`Restart=always` in the unit only restarts a process that **exits**. The failure
seen in the field is the opposite: the app stays up while its webview stops
answering, so the relay goes deaf and systemd has nothing to act on (`NRestarts=0`
while Telegram was dead for 9 hours). The watchdog covers that case by asking the
app whether it is still there.

Health is decided by the control plane, not by a socket check: `ss | grep 149.154`
is timing-dependent, because long-poll disconnects and reconnects, so a healthy
relay can show no Telegram socket at that instant and a socket check would restart
it for nothing. The watchdog requires `termigo-cli status --json` to answer with a
non-null `"ui"` and the process RSS to look like a completed boot.

Install it as a systemd timer (preferred over cron: it is logged by journald and
survives a reboot):

```bash
sudo tee /etc/systemd/system/termigo-watchdog.service >/dev/null <<'EOF'
[Unit]
Description=Termigo watchdog (detect a live but wedged app and restart it)
After=termigo.service

[Service]
Type=oneshot
TimeoutStartSec=180
# MUST run as the user that owns the app, because termigo-cli reads the control
# descriptor from that user's cache directory. As root it finds no descriptor at
# /root/.cache, answers app_unavailable every time, and the watchdog would
# restart the service forever - a mistake worth one evening.
User=admin
Environment=HOME=/home/admin
ExecStart=/opt/termigo/scripts/termigo-watchdog.sh
EOF

sudo tee /etc/systemd/system/termigo-watchdog.timer >/dev/null <<'EOF'
[Unit]
Description=Run the Termigo watchdog every 2 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
AccuracySec=15s
Unit=termigo-watchdog.service

[Install]
WantedBy=timers.target
EOF

# The rollback path needs a known-good binary; without it the watchdog logs
# that it skipped the rollback and keeps restarting the same bad build.
cp -p /opt/termigo/termigo /opt/termigo/termigo.known-good

sudo systemctl daemon-reload
sudo systemctl enable --now termigo-watchdog.timer
systemctl list-timers termigo-watchdog.timer
```

What it does, in order: exit if the service has been up for less than `GRACE_SECS`
(so a boot in progress is not judged and cannot cause a restart loop); reset the
failure counter when healthy; otherwise restart, and after `MAX_RESTARTS`
consecutive failures restore `termigo.known-good` over the pinned binary before
restarting again. Its decisions are appended to `/opt/termigo/.watchdog/watchdog.log`.

```bash
# What the watchdog has been deciding
sudo tail -30 /opt/termigo/.watchdog/watchdog.log
```

### Memory: why a build inside the relay is dangerous

The unit's `MemoryHigh` / `MemoryMax` apply to the **whole process tree**. Every
PTY shell and every command the agent runs is a child of the app, so their memory
is charged to the app's quota. Measured on a field install: an agent ran node and
rustc builds inside the relay, the cgroup reached its 2 GB `MemoryHigh`, the
webview was throttled until it stopped answering, and Telegram was dead for nine
hours with `NRestarts=0` (systemd had nothing to act on, because the process never
exited). The watchdog now catches that, but restarting mid-audit loses the work.

`scripts/run-headless.sh` therefore caps the two biggest consumers before the app
starts, and the caps are inherited by PTY shells and by the agent's commands:

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_OPTIONS` | `--max-old-space-size=1536` | Bounds the V8 heap for vite, tsc, rollup and any other node build step. |
| `CARGO_BUILD_JOBS` | `1` | Serialises rustc. A parallel release build was already OOM-killed on this box. |

This limits builds rather than forbidding them, so an agent can still verify that
the project compiles. If a build genuinely needs more, override the variable for
that one run instead of raising the service limit:

```bash
cd /opt/termigo
CARGO_BUILD_JOBS=2 NODE_OPTIONS=--max-old-space-size=3072 pnpm build
```

Better still, do a full build with the relay **stopped** (see
[Updating Termigo](#updating-termigo)): it removes the contention entirely instead
of tuning around it.

### Backup

Regularly back up:
- `/opt/termigo/termigo.bak-*` (binary rollback chain)
- `/opt/termigo/termigo.known-good` (what the watchdog rolls back to)
- `~/.local/share/id.99apps.termigo/` (settings, sessions, secrets)
- `/etc/systemd/system/termigo.service` and `termigo-watchdog.{service,timer}` (service units)
