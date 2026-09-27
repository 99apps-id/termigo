# Platform and bundle

Window styling per platform, the Tauri capability allowlist, cross-platform
conventions, and bundle / updater configuration. Moved here from `TERMIGO.md`
so that file fits the 10 KB of project memory the agent is given; `TERMIGO.md`
keeps the rules that are invariants and points here for the rest.

### Window styling

- macOS: `titleBarStyle: Overlay` + `hiddenTitle: true` in `tauri.conf.json` (native traffic lights via overlay).
- Linux: `decorations: false` + `transparent: true` from `tauri.linux.conf.json`; re-asserted post-realize for GNOME/Mutter CSD.
- Windows: same as Linux via `tauri.windows.conf.json`. React renders custom `WindowControls`.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS**: `minimumSystemVersion: 13.0`.
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `embedBootstrapper` (offline install).
- Auto-updater configured with a public minisign key; release artifacts at `https://github.com/99apps-id/termigo/releases/latest/download/latest.json`.

### Size budgets

The bundle claim lives in `ROADMAP.md` (theme 2) and `TERMIGO.md`; the numbers
below are what actually enforces it. `pnpm size` runs `size-limit` against the
built `dist/`, and CI runs that step (`.github/workflows/ci.yml`), so a raise is
a deliberate edit rather than something that drifts in.

| Budget | Limit | Measured 2026-09-27 | Headroom |
|---|---|---|---|
| Main window startup JS (eager modulepreload) | 540 kB gz | 391 kB gz | 38% |
| Total client JS (all lazy chunks) | 4.25 MB gz | 3.63 MB gz | 17% |
| Total client bundle (JS, CSS, HTML, fonts) | 4.6 MB gz | 3.92 MB gz | 17% |
| Windows installer | under 20 MB | 10.1 MB NSIS, 13.2 MB MSI | 51% (worst case) |
| Headless binary | 16-48 MB (`headless-vps.md`) | 30.9 MB | inside |

Every figure in the Measured column is what `pnpm size` itself prints, never a
manual approximation: a bare `zlib` sum of the same files reads about 4% lower
(3.48 MB of JS, 3.75 MB of bundle), and a table that quotes a different number
than the one CI compares against is worse than no table.

Rules that keep these honest:

- **Measure before changing a limit.** Every number above came from a build of
  the commit it was recorded with; a limit raised without a measurement is how a
  budget stops meaning anything.
- **Keep roughly 15-20% headroom.** Enough that a normal feature does not trip
  CI, tight enough that a heavy dependency does. The eager budget carries more
  because it is the one that gates first paint.
- **The whole-bundle entry exists because the two JS entries cannot see CSS,
  fonts or HTML.** Those ship to the webview too (217 kB of CSS alone), and
  nothing guarded them until this entry.
- **The 7-8 MB figure was the pre-editor bundle.** It predated the editor, LSP,
  source control and AI subsystems. Recorded as a deliberate raise, not as drift.
- A raise beyond the headroom is a decision to state in the commit that makes
  it, with the reason the weight is justified.
