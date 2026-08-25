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
  | { id: number; kind: "ai:getState" }
  | { id: number; kind: "ai:setModel"; modelId: string; provider: string }
  | { id: number; kind: "ai:setSubagentsEnabled"; enabled: boolean }
  | { id: number; kind: "ai:sendPrompt"; text: string }
  | { id: number; kind: "ai:stop" }
  | { id: number; kind: "tool:register"; name: string }
  | { id: number; kind: "command:register"; commandId: string }
  | { id: number; kind: "panel:open"; panelId: string }
  | { id: number; kind: "panel:close" }
  | { id: number; kind: "panel:toggle"; panelId: string }
  | { id: number; kind: "ui:mountPanel"; panelId: string; html: string; events: string[] }
  | { id: number; kind: "headerbar:set"; item: SerializedHeaderItem }
  | { id: number; kind: "headerbar:remove"; itemId: string }
  | { id: number; kind: "statusbar:set"; item: SerializedStatusItem }
  | { id: number; kind: "statusbar:remove"; itemId: string }
  | { id: number; kind: "dom:unsupported"; surface: string }
  | { id: number; kind: "logger"; level: "info" | "warn" | "error"; args: unknown[] };

/** Reply from the host to a sandbox request. */
export type SandboxResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

/** Header / status items are host-managed in the sandbox: the worker sends a
 *  serializable spec (no function) and the host renders it; clicks route back
 *  to the worker via `ui:itemClick` with the `event` name. */
export type SerializedHeaderItem = {
  id: string;
  icon: string;
  tooltip: string;
  tone?: "default" | "success" | "warning" | "error";
  placement?: "left" | "right";
  event?: string;
};

export type SerializedStatusItem = {
  id: string;
  icon: string;
  tooltip: string;
  tone?: "default" | "success" | "warning" | "error";
  label?: string;
  progress?: number;
  kind?: "status" | "action";
  event?: string;
};

/** Inbound message from the host to the worker (init + calls the host owns). */
export type HostMessage =
  | { type: "init"; id: string; code: string }
  | { type: "invoke_tool"; name: string; args: Record<string, unknown>; callId: number }
  | { type: "invoke_command"; id: string; args: unknown[]; callId: number }
  | { type: "event"; channel: string; payload: unknown }
  | { type: "ui:event"; panelId: string; event: string; fields?: Record<string, string> }
  | { type: "ui:itemClick"; surface: "header" | "status"; id: string; event: string }
  | { type: "deactivate" };

/** Outbound message from the worker to the host for calls the host initiated. */
export type WorkerMessage =
  | { type: "ready"; id: string }
  | { type: "tool_result"; callId: number; ok: true; value: unknown }
  | { type: "tool_result"; callId: number; ok: false; error: string }
  | { type: "command_result"; callId: number; ok: true; value: unknown }
  | { type: "command_result"; callId: number; ok: false; error: string };

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
  aiGetState(): unknown;
  aiSetModel(modelId: string, provider: string): Promise<void>;
  aiSetSubagentsEnabled(enabled: boolean): Promise<void>;
  aiSendPrompt(text: string): Promise<boolean>;
  aiStop(): void;
  /** Called when the worker registers an AI tool handler; the host sets a
   *  bridge handler in the aiTools registry so the agent can invoke it. */
  onToolRegister(name: string): void;
  /** Called when the worker registers a command handler; the host sets a bridge
   *  handler in the commands registry. */
  onCommandRegister(id: string): void;
  panelOpen(panelId: string): void;
  panelClose(): void;
  panelToggle(panelId: string): void;
  /** Called when the worker mounts a host-managed panel view. The host stores
   *  the HTML and wires `data-ext-event` clicks back to the worker. */
  onPanelMount(panelId: string, html: string, events: string[]): void;
  headerBarSet(item: SerializedHeaderItem): void;
  headerBarRemove(id: string): void;
  statusBarSet(item: SerializedStatusItem): void;
  statusBarRemove(id: string): void;
  onDomUnsupported(surface: string): void;
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
        case "ai:getState":
          value = executor.aiGetState();
          break;
        case "ai:setModel":
          require("ai:configure");
          await executor.aiSetModel(req.modelId, req.provider);
          value = undefined;
          break;
        case "ai:setSubagentsEnabled":
          require("ai:configure");
          await executor.aiSetSubagentsEnabled(req.enabled);
          value = undefined;
          break;
        case "ai:sendPrompt":
          require("ai:prompt");
          value = await executor.aiSendPrompt(req.text);
          break;
        case "ai:stop":
          executor.aiStop();
          value = undefined;
          break;
        case "tool:register":
          executor.onToolRegister(req.name);
          value = undefined;
          break;
        case "command:register":
          executor.onCommandRegister(req.commandId);
          value = undefined;
          break;
        case "panel:open":
          require("panels:register");
          executor.panelOpen(req.panelId);
          value = undefined;
          break;
        case "panel:close":
          require("panels:register");
          executor.panelClose();
          value = undefined;
          break;
        case "panel:toggle":
          require("panels:register");
          executor.panelToggle(req.panelId);
          value = undefined;
          break;
        case "ui:mountPanel": {
          // Mounting a panel renders HTML, not raw IPC; the permission gate is
          // the same as opening a panel, so an extension cannot smuggle a
          // renderer without `panels:register`.
          require("panels:register");
          executor.onPanelMount(req.panelId, req.html, req.events);
          value = undefined;
          break;
        }
        case "dom:unsupported":
          executor.onDomUnsupported(req.surface);
          value = undefined;
          break;
        case "headerbar:set":
          require("headerbar:write");
          executor.headerBarSet(req.item);
          value = undefined;
          break;
        case "headerbar:remove":
          require("headerbar:write");
          executor.headerBarRemove(req.itemId);
          value = undefined;
          break;
        case "statusbar:set":
          require("statusbar:write");
          executor.statusBarSet(req.item);
          value = undefined;
          break;
        case "statusbar:remove":
          require("statusbar:write");
          executor.statusBarRemove(req.itemId);
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
