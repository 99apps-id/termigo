# Extensions and the sandbox

Extensions let third-party code add AI tools, commands, keybindings, panels,
header/status items, settings, and sidebar sections to Termigo. This guide
covers the manifest, the registries, and the sandbox model that keeps
untrusted extension code off the main UI thread.

If anything here conflicts with `TERMIGO.md`, `TERMIGO.md` wins.

## Manifest

An extension is a folder with a `manifest.json` validated against
`src/modules/extensions/manifest.ts` (Zod). The shape is:

- `id` and `name` identifies the extension.
- `main` is the entry module loaded by the loader.
- `sandbox` - `"worker"` runs the extension in a Web Worker (no `window`,
  `document`, or `@tauri-apps/api/core`); omit it to run in-webview.
- `aiTools` - tool definitions contributed to the agent tool set.
- `commands` - commands the extension registers.
- `keybindings` - keybindings the extension binds.
- `panels` - host-rendered panels.
- `settings` - settings the extension declares.
- `headerItems`, `statusItems`, `sidebarSections` - chrome contributions.

## Registries

`src/modules/extensions/registries.ts` holds the runtime registries that the
loader populates at boot:

- `aiToolsRegistry`, `commandsRegistry`, `panelsRegistry`, `settingsRegistry`
- `headerItemsRegistry`, `statusItemsRegistry`, `sidebarSectionsRegistry`
- `panelRenderersRegistry`

## Loader

`src/modules/extensions/loader.ts` boots enabled extensions. For each one it
dynamic-imports `main` and calls `activate(ctx)`. When `manifest.sandbox ===
"worker"` it calls `activateSandboxed` instead of importing the extension into
the webview.

See `src/modules/extensions/` for the exact entry points.

## Sandbox model

An extension with `"sandbox": "worker"` runs in a Web Worker. It has no DOM and
cannot reach the Tauri IPC directly. Instead the host owns the DOM:

1. The worker sends serializable specs: an HTML template plus the event names
   it cares about, and header/status items and sidebar sections.
2. The host renders those and routes clicks back to the worker over RPC
   (`ui:event`, `ui:itemClick`, `ui:sidebarEvent`).
3. Permission enforcement lives in `createSandboxDispatcher`
   (`src/modules/extensions/sandbox.ts`), which decides which requests
   (`invoke`, `storage`, `settings`, `secrets`, `ai:*`, tool/command/panel
   registration, `logger`, ...) the worker may make.

The worker runtime is `src/modules/extensions/sandboxWorker.ts`; the host side
is `src/modules/extensions/sandboxHost.ts`.

### Worker-side API

- `panel.on(event, handler(fields))`, `panel.setView`
- `headerBar.setItem` / `statusBar.setItem` (serialize `onClick` to event
  names)
- `sidebar.setSection` (serializes callbacks to event names)

### Host-managed DOM

`onPanelMount` sets a host renderer that innerHTMLs the worker template and
routes `data-ext-event`, `data-ext-field`, and `data-ext-arg`. `headerBarSet`,
`statusBarSet`, and `sidebarSet` route events back via `postToWorker`.

## Security posture

Running extension code in a worker is the trust boundary: it has no access to
the DOM or the Tauri IPC except through the dispatcher, which enforces
permission per request kind. Mutating AI tools still go through the normal
approval flow (`needsApproval`), and the secret-path deny-list and SSRF guard
apply to any request the extension forwards.
