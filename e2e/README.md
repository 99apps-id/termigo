# Termigo end-to-end tests

Smoke tests that boot the **real** Termigo binary and drive its webview through
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/) +
[WebdriverIO](https://webdriver.io). Unlike the unit tests (Vitest / `cargo
nextest`), these exercise the Rust backend, the IPC surface and the UI together
— the integration layer where the nastiest bugs hide (a boot crash, a blank
window, a terminal that never spawns because a Rust command wasn't registered).

Kept as a **standalone package** (its own `package.json`, outside the pnpm
workspace) so the heavy WDIO stack never touches the app's dependency tree or
lockfile.

> **Platform:** `tauri-driver` supports **Linux and Windows only** (no macOS).
> CI runs these on Linux.

## Prerequisites

1. A **release build** of the app: `pnpm tauri build` (or `cargo build
   --release` in `src-tauri/`). Override the binary path with
   `TERMIGO_E2E_BINARY`.
2. **tauri-driver**: `cargo install tauri-driver --locked`.
3. The **native webview driver** on `PATH`:
   - Linux: `WebKitWebDriver` (Debian/Ubuntu: `apt install webkit2gtk-driver`).
   - Windows: `msedgedriver.exe` matching your Edge/WebView2 version; point
     `TAURI_DRIVER_NATIVE` at it if it isn't on `PATH`.

## Run

```bash
cd e2e
pnpm install --ignore-workspace   # standalone install, its own lockfile
pnpm test                         # wdio run ./wdio.conf.ts
```

Environment overrides:

- `TERMIGO_E2E_BINARY` — absolute path to the app binary to launch.
- `TAURI_DRIVER_NATIVE` — path to the native driver (Windows `msedgedriver`).

## Adding tests

Specs live in `specs/*.e2e.ts` and use the WebdriverIO globals (`$`, `$$`,
`browser`, `expect`). Prefer the stable `data-*` hooks the app already exposes
(`data-terminal-tab`, `data-tab-id`, `data-pane-leaf`) over brittle text or
class selectors. Keep smoke specs shallow and resilient: they guard the boot and
integration path, not fine UI detail.
