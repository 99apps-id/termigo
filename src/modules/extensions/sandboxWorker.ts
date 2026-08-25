/// <reference lib="webworker" />
// Worker-side runtime for sandboxed extensions.
//
// Runs inside a dedicated Web Worker (no window, no document, no
// `@tauri-apps/api/core`). It receives the extension's `main` module as a blob,
// imports it, and calls `activate(ctx)`. The `ctx` is a postMessage proxy: each
// call sends a request to the host, which enforces permissions and replies.
// AI-tool and command handlers registered by the extension stay here and are
// driven by inbound `invoke_tool` / `invoke_command` messages from the host.

import type { HostMessage, SandboxRequest, WorkerMessage } from "./sandbox";

declare const self: DedicatedWorkerGlobalScope;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Handler = (args: unknown) => unknown | Promise<unknown>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let idSeq = 1;
const pending = new Map<number, Pending>();
const toolHandlers = new Map<string, Handler>();
const commandHandlers = new Map<string, Handler>();
const panelHandlers = new Map<string, (fields: Record<string, string>) => void>();
const itemHandlers = new Map<string, () => void>();
const listeners = new Map<string, ((payload: unknown) => void)[]>();

function send(msg: WorkerMessage): void {
  self.postMessage(msg);
}

function call(req: DistributiveOmit<SandboxRequest, "id">): Promise<unknown> {
  const id = idSeq++;
  const p = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
  const msg = { ...req, id } as SandboxRequest;
  self.postMessage({ kind: "request", req: msg });
  return p;
}

/** Build the ctx proxy handed to the extension's activate(). */
function buildCtx(id: string): Record<string, unknown> {
  return {
    id,
    installPath: "",
    os: { platform: "unknown", arch: "unknown" },
    paths: { home: "" },
    storage: {
      get: (key: string) => call({ kind: "storage:get", key }),
      set: (key: string, value: unknown) => call({ kind: "storage:set", key, value }),
      delete: (key: string) => call({ kind: "storage:delete", key }),
    },
    settings: {
      get: (key: string) => call({ kind: "settings:get", key }),
      set: (key: string, value: unknown) => call({ kind: "settings:set", key, value }),
      onChange: (key: string, cb: (v: unknown) => void) => {
        const channel = `settings:${key}`;
        const list = listeners.get(channel) ?? [];
        list.push(cb);
        listeners.set(channel, list);
        return () => {
          const cur = listeners.get(channel);
          if (cur) listeners.set(channel, cur.filter((x) => x !== cb));
        };
      },
    },
    secrets: {
      get: (name: string) => call({ kind: "secrets:get", name }),
      set: (name: string, value: string) => call({ kind: "secrets:set", name, value }),
      delete: (name: string) => call({ kind: "secrets:delete", name }),
    },
    ai: {
      getState: () => call({ kind: "ai:getState" }),
      setModel: (modelId: string, provider: string) =>
        call({ kind: "ai:setModel", modelId, provider }),
      setSubagentsEnabled: (enabled: boolean) =>
        call({ kind: "ai:setSubagentsEnabled", enabled }),
      sendPrompt: (text: string) => call({ kind: "ai:sendPrompt", text }),
      stop: () => call({ kind: "ai:stop" }),
      onStateChange: () => () => {},
    },
    logger: {
      info: (...args: unknown[]) => call({ kind: "logger", level: "info", args }),
      warn: (...args: unknown[]) => call({ kind: "logger", level: "warn", args }),
      error: (...args: unknown[]) => call({ kind: "logger", level: "error", args }),
    },
    registerAiToolHandler: (name: string, handler: Handler) => {
      toolHandlers.set(name, handler);
      void call({ kind: "tool:register", name });
    },
    registerCommandHandler: (id: string, handler: Handler) => {
      commandHandlers.set(id, handler);
      void call({ kind: "command:register", commandId: id });
    },
    addDisposer: () => {},
    // DOM / UI surfaces are host-managed in the sandbox. Panels, header items
    // and status items are rendered by the host from a serializable spec; clicks
    // route back to the worker over `ui:event` / `ui:itemClick`.
    headerBar: {
      setItem: (item: { id: string; icon: string; tooltip: string; tone?: string; placement?: string; onClick?: () => void }) => {
        const event = item.onClick ? `hb:${item.id}` : undefined;
        if (item.onClick && event) itemHandlers.set(event, item.onClick);
        return call({
          kind: "headerbar:set",
          item: {
            id: item.id,
            icon: item.icon,
            tooltip: item.tooltip,
            tone: item.tone as "default" | "success" | "warning" | "error" | undefined,
            placement: item.placement as "left" | "right" | undefined,
            event,
          },
        });
      },
      removeItem: (id: string) => call({ kind: "headerbar:remove", itemId: id }),
    },
    statusBar: {
      setItem: (item: { id: string; icon: string; tooltip: string; tone?: string; label?: string; progress?: number; kind?: string; onClick?: () => void }) => {
        const event = item.onClick ? `sb:${item.id}` : undefined;
        if (item.onClick && event) itemHandlers.set(event, item.onClick);
        return call({
          kind: "statusbar:set",
          item: {
            id: item.id,
            icon: item.icon,
            tooltip: item.tooltip,
            tone: item.tone as "default" | "success" | "warning" | "error" | undefined,
            label: item.label,
            progress: item.progress,
            kind: item.kind as "status" | "action" | undefined,
            event,
          },
        });
      },
      removeItem: (id: string) => call({ kind: "statusbar:remove", itemId: id }),
    },
    registerPanelRenderer: (panelId: string, view: unknown) => {
      if (view && typeof view === "object" && "html" in view) {
        const spec = view as { html: string; events?: string[] };
        return call({ kind: "ui:mountPanel", panelId, html: spec.html, events: spec.events ?? [] });
      }
      // A function renderer cannot cross a worker boundary; host-managed panels
      // take an HTML template instead. Degrade so the extension is honest.
      return call({ kind: "dom:unsupported", surface: "panel" });
    },
    panel: {
      open: (panelId: string) => call({ kind: "panel:open", panelId }),
      close: () => call({ kind: "panel:close" }),
      toggle: (panelId: string) => call({ kind: "panel:toggle", panelId }),
      setView: (panelId: string, html: string, events: string[] = []) =>
        call({ kind: "ui:mountPanel", panelId, html, events }),
      on: (event: string, handler: (fields: Record<string, string>) => void) => {
        panelHandlers.set(event, handler);
      },
    },
    sidebar: {
      setSection: () => call({ kind: "dom:unsupported", surface: "sidebar" }),
      removeSection: () => {},
    },
    app: {
      getContext: () => ({}),
      onContextChange: () => () => {},
      setSidebarVisible: () => {},
      setRightSidebarVisible: () => {},
    },
    editor: { getActive: () => null, setActiveContent: () => {} },
    events: {
      emit: () => call({ kind: "logger", level: "info", args: ["events not supported in sandbox"] }),
      on: () => () => {},
    },
  };
}

async function handle(msg: HostMessage): Promise<void> {
  switch (msg.type) {
    case "init": {
      try {
        const url = URL.createObjectURL(
          new Blob([msg.code], { type: "text/javascript" }),
        );
        const mod = (await import(/* @vite-ignore */ url)) as {
          activate?: (ctx: Record<string, unknown>) => unknown;
          default?: { activate?: (ctx: Record<string, unknown>) => unknown };
        };
        const ctx = buildCtx(msg.id);
        const activateFn = mod.activate ?? mod.default?.activate;
        if (typeof activateFn === "function") {
          await activateFn(ctx);
        }
        send({ type: "ready", id: msg.id });
      } catch (e) {
        send({ type: "ready", id: msg.id });
        console.error(`[ext:${msg.id}] sandbox activate failed`, e);
      }
      break;
    }
    case "invoke_tool": {
      const fn = toolHandlers.get(msg.name);
      try {
        const value = fn ? await fn(msg.args) : { error: "no handler bound" };
        send({ type: "tool_result", callId: msg.callId, ok: true, value });
      } catch (e) {
        send({ type: "tool_result", callId: msg.callId, ok: false, error: String(e) });
      }
      break;
    }
    case "invoke_command": {
      const fn = commandHandlers.get(msg.id);
      try {
        const value = fn ? await fn(msg.args) : undefined;
        send({ type: "command_result", callId: msg.callId, ok: true, value });
      } catch (e) {
        send({ type: "command_result", callId: msg.callId, ok: false, error: String(e) });
      }
      break;
    }
    case "event": {
      for (const cb of listeners.get(msg.channel) ?? []) cb(msg.payload);
      break;
    }
    case "ui:event": {
      // Host-managed panel click. The host rendered our HTML and routed an
      // element's `data-ext-event` here (with its `data-ext-field` values);
      // run the bound handler.
      const fn = panelHandlers.get(msg.event);
      if (fn) void fn(msg.fields ?? {});
      break;
    }
    case "ui:itemClick": {
      const fn = itemHandlers.get(msg.event);
      if (fn) fn();
      break;
    }
    case "deactivate":
      break;
  }
}

self.onmessage = (e) => {
  const data = e.data as {
    type?: string;
    id?: number;
    ok?: boolean;
    value?: unknown;
    error?: string;
  };
  if (!data) return;
  // Host-initiated messages always carry a `type`.
  if (data.type !== undefined) {
    void handle(data as unknown as HostMessage);
    return;
  }
  // Otherwise it is a reply to one of our `call` requests.
  const p = data.id !== undefined ? pending.get(data.id) : undefined;
  if (p) {
    if (data.id !== undefined) pending.delete(data.id);
    if (data.ok) p.resolve(data.value);
    else p.reject(new Error(data.error ?? "error"));
  }
};
