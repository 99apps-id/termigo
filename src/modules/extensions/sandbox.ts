// Sandboxed extension execution (Fase B foundation).
//
// Extensions declared `"sandbox": "worker"` in their manifest run their JS in a
// Web Worker instead of the main webview. A worker has no `window`, no
// `document`, and no `@tauri-apps/api/core`, so the v1 bypass (an extension
// importing the Tauri IPC directly, see the note in `permissions.ts`) is gone.
// Every host capability is reached through a postMessage RPC bridge, and the
// host enforces the same permissions the in-webview ctx uses.
//
// This module holds the protocol and the host-side dispatcher. It is kept free
// of DOM and of `@tauri-apps/api/core` so it is unit-testable in isolation.
// Subscriptions (settings.onChange, events, ai.onStateChange) and the
// AI-tool / command handler bridge are layered on top in `sandboxHost.ts`.

import { checkPermission } from "./permissions";

/** Outbound request from the sandbox (extension) to the host. */
export type SandboxRequest =
  | { id: number; kind: "invoke"; command: string; args?: Record<string, unknown> }
  | { id: number; kind: "storage:get"; key: string }
  | { id: number; kind: "storage:set"; key: string; value: unknown }
  | { id: number; kind: "storage:delete"; key: string }
  | { id: number; kind: "settings:get"; key: string }
  | { id: number; kind: "settings:set"; key: string; value: unknown }
  | { id: number; kind: "secrets:get"; name: string }
  | { id: number; kind: "secrets:set"; name: string; value: string }
  | { id: number; kind: "secrets:delete"; name: string }
  | { id: number; kind: "logger"; level: "info" | "warn" | "error"; args: unknown[] };

/** Reply from the host to a sandbox request. */
export type SandboxResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

/** The capability surface a worker-sandboxed extension can call. The host
 *  implements these; `createSandboxDispatcher` gates the security-adjacent ones. */
export type SandboxExecutor = {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<void>;
  storageDelete(key: string): Promise<void>;
  settingsGet(key: string): Promise<unknown>;
  settingsSet(key: string, value: unknown): Promise<void>;
  secretsGet(name: string): Promise<string | null>;
  secretsSet(name: string, value: string): Promise<void>;
  secretsDelete(name: string): Promise<void>;
  log(level: "info" | "warn" | "error", args: unknown[]): void;
};

/** Build a dispatcher bound to one extension's id and approved permissions.
 *  Returns a function that handles a single `SandboxRequest`. Security-adjacent
 *  calls (invoke / storage / settings / secrets) are checked here before the
 *  executor runs, so a sandboxed extension cannot reach the backend without the
 *  approved permission, exactly like the in-webview ctx. */
export function createSandboxDispatcher(
  ext: { id: string; declared: readonly string[] },
  executor: SandboxExecutor,
): (req: SandboxRequest) => Promise<SandboxResponse> {
  const require = (permission: string): void => {
    if (!checkPermission(ext.declared, permission)) {
      throw new Error(`extension "${ext.id}" lacks permission "${permission}"`);
    }
  };

  return async (req): Promise<SandboxResponse> => {
    try {
      let value: unknown;
      switch (req.kind) {
        case "invoke": {
          require(`invoke:${req.command}`);
          value = await executor.invoke(req.command, req.args);
          break;
        }
        // Storage is a per-extension, isolated JSON file (tauri-plugin-store
        // `tedi-ext-<id>.json`), so it is not permission-gated like settings
        // or secrets — mirroring the in-webview `ctx.storage`.
        case "storage:get":
          value = await executor.storageGet(req.key);
          break;
        case "storage:set":
          await executor.storageSet(req.key, req.value);
          value = undefined;
          break;
        case "storage:delete":
          await executor.storageDelete(req.key);
          value = undefined;
          break;
        case "settings:get":
          require("settings:read");
          value = await executor.settingsGet(req.key);
          break;
        case "settings:set":
          require("settings:write");
          await executor.settingsSet(req.key, req.value);
          value = undefined;
          break;
        case "secrets:get":
          require("secrets:read");
          value = await executor.secretsGet(req.name);
          break;
        case "secrets:set":
          require("secrets:write");
          await executor.secretsSet(req.name, req.value);
          value = undefined;
          break;
        case "secrets:delete":
          require("secrets:write");
          await executor.secretsDelete(req.name);
          value = undefined;
          break;
        case "logger":
          executor.log(req.level, req.args);
          value = undefined;
          break;
        default: {
          const never: never = req;
          throw new Error(`unknown sandbox request: ${String(never)}`);
        }
      }
      return { id: req.id, ok: true, value };
    } catch (e) {
      return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
