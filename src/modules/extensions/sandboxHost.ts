// Host side of the sandboxed extension execution.
//
// Creates the Web Worker for a `"sandbox": "worker"` extension, drives the RPC,
// and enforces permissions through `createSandboxDispatcher`. When the worker
// registers an AI tool or command handler, we set a bridge handler in the
// registry so the agent / command palette can invoke it (the worker holds the
// real handler and replies over the message channel).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { toast } from "@/components/ui/toast";
import * as chatMod from "@/modules/ai/store/chatStore";
import { aiToolsRegistry, commandsRegistry, headerItemsRegistry, panelRenderersRegistry, sidebarSectionsRegistry, statusItemsRegistry } from "./registries";
import { useRightPanelStore } from "./rightPanelStore";
import type { ExtensionRuntime } from "./host";
import {
  createSandboxDispatcher,
  type SandboxExecutor,
  type SandboxRequest,
  type SerializedSidebarSection,
  type WorkerMessage,
} from "./sandbox";

const STORAGE_FILE = (id: string) => `tedi-ext-${id}.json`;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

type BridgeHooks = {
  invokeTool: (name: string, args: unknown) => Promise<unknown>;
  invokeCommand: (id: string, args: unknown[]) => Promise<unknown>;
};

async function buildExecutor(
  ext: ExtensionRuntime,
  hooks: BridgeHooks,
  postToWorker: (
    msg:
      | { type: "ui:event"; panelId: string; event: string; fields?: Record<string, string> }
      | { type: "ui:itemClick"; surface: "header" | "status"; id: string; event: string }
      | {
          type: "ui:sidebarEvent";
          kind: "click" | "toggle" | "action" | "context";
          sectionId: string;
          itemId?: string;
          actionId?: string;
          event: string;
        },
  ) => void,
): Promise<SandboxExecutor> {
  const store = new LazyStore(STORAGE_FILE(ext.id), { defaults: {}, autoSave: 200 });
  const log = (level: "info" | "warn" | "error", args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console[level](`[ext:${ext.id}]`, ...args);
  };

  return {
    invoke: (command, args) => tauriInvoke(command, args),
    storageGet: async (key) => (await store.get(key)) ?? null,
    storageSet: async (key, value) => {
      await store.set(key, value);
      await store.save();
    },
    storageDelete: async (key) => {
      await store.delete(key);
      await store.save();
    },
    settingsGet: async (key) => {
      const mod = await import("@/modules/settings/store");
      return (await mod._readAny(`ext:${ext.id}:${key}`)) ?? undefined;
    },
    settingsSet: async (key, value) => {
      const mod = await import("@/modules/settings/store");
      await mod._writeAny(`ext:${ext.id}:${key}`, value);
    },
    secretsGet: (name) =>
      tauriInvoke<string | null>("secrets_get", {
        service: `tedi-ext:${ext.id}`,
        account: name,
      }),
    secretsSet: (name, value) =>
      tauriInvoke("secrets_set", {
        service: `tedi-ext:${ext.id}`,
        account: name,
        password: value,
      }),
    secretsDelete: (name) =>
      tauriInvoke("secrets_delete", {
        service: `tedi-ext:${ext.id}`,
        account: name,
      }),
    aiGetState: () => ({
      provider: chatMod.useChatStore.getState().selectedModelId?.split(":")[0] ?? "",
      modelId: chatMod.useChatStore.getState().selectedModelId ?? "",
      hasKey: false,
    }),
    aiSetModel: async (modelId, provider) => {
      chatMod.useChatStore.getState().setSelectedModelId(`${provider}:${modelId}`);
    },
    aiSetSubagentsEnabled: async () => {},
    aiSendPrompt: async () => false,
    aiStop: () => chatMod.stop(),
    onToolRegister: (name) => {
      aiToolsRegistry.setRuntime(ext.id, name, (args: unknown) => hooks.invokeTool(name, args));
    },
    onCommandRegister: (id) => {
      commandsRegistry.setRuntime(ext.id, id, (...args: unknown[]) => hooks.invokeCommand(id, args));
    },
    panelOpen: (panelId) => {
      useRightPanelStore.getState().open(ext.id, panelId);
    },
    panelClose: () => {
      useRightPanelStore.getState().close(ext.id);
    },
    panelToggle: (panelId) => {
      useRightPanelStore.getState().toggle(ext.id, panelId);
    },
    onPanelMount: (panelId, html, events) => {
      void events;
      // Host-managed panel: the worker sent an HTML template. The host renders
      // it and routes any `data-ext-event` click back to the worker, so the
      // extension keeps its interactive handlers without running DOM code in
      // the main webview.
      panelRenderersRegistry.set(ext.id, panelId, (container) => {
        container.innerHTML = html;
        const handler = (e: Event): void => {
          const target = e.target as HTMLElement | null;
          const ev = target?.getAttribute?.("data-ext-event");
          if (!ev) return;
          // Send the clicked element's `data-ext-field` values back too, so the
          // worker can read the current value of an input without touching the
          // host DOM.
          const fields: Record<string, string> = {};
          container
            .querySelectorAll<HTMLElement>("[data-ext-field]")
            .forEach((el) => {
              const name = el.getAttribute("data-ext-field");
              if (name) {
                const input = el as HTMLInputElement;
                fields[name] = input.value ?? el.textContent ?? "";
              }
            });
          // Allow per-element args (e.g. a scope chip that carries its target on
          // its own remove button) without a hidden input per row.
          const dataExtArg = target?.getAttribute?.("data-ext-arg");
          if (dataExtArg) fields.arg = dataExtArg;
          postToWorker({ type: "ui:event", panelId, event: ev, fields });
        };
        container.addEventListener("click", handler);
        return () => {
          container.removeEventListener("click", handler);
        };
      });
    },
    headerBarSet: (item) => {
      headerItemsRegistry.set(ext.id, {
        id: item.id,
        icon: item.icon,
        tooltip: item.tooltip,
        tone: item.tone,
        placement: item.placement,
        onClick: () => {
          if (item.event) postToWorker({ type: "ui:itemClick", surface: "header", id: item.id, event: item.event });
        },
      });
    },
    headerBarRemove: (id) => {
      headerItemsRegistry.remove(ext.id, id);
    },
    statusBarSet: (item) => {
      statusItemsRegistry.set(ext.id, {
        id: item.id,
        icon: item.icon,
        tooltip: item.tooltip,
        tone: item.tone,
        label: item.label,
        progress: item.progress,
        kind: item.kind,
        onClick: () => {
          if (item.event) postToWorker({ type: "ui:itemClick", surface: "status", id: item.id, event: item.event });
        },
      });
    },
    statusBarRemove: (id) => {
      statusItemsRegistry.remove(ext.id, id);
    },
    sidebarSet: (section: SerializedSidebarSection) => {
      sidebarSectionsRegistry.set(ext.id, {
        id: section.id,
        title: section.title,
        icon: section.icon,
        headerActions: section.headerActions,
        items: section.items,
        emptyText: section.emptyText,
        searchable: section.searchable,
        searchPlaceholder: section.searchPlaceholder,
        movableToRight: section.movableToRight,
        onItemClick: (itemId) => {
          if (section.eventClick) postToWorker({ type: "ui:sidebarEvent", kind: "click", sectionId: section.id, itemId, event: section.eventClick });
        },
        onItemToggle: (itemId) => {
          if (section.eventToggle) postToWorker({ type: "ui:sidebarEvent", kind: "toggle", sectionId: section.id, itemId, event: section.eventToggle });
        },
        onItemAction: (itemId, actionId) => {
          if (section.eventAction) postToWorker({ type: "ui:sidebarEvent", kind: "action", sectionId: section.id, itemId, actionId, event: section.eventAction });
        },
        onItemContextMenu: (itemId) => {
          if (section.eventContext) postToWorker({ type: "ui:sidebarEvent", kind: "context", sectionId: section.id, itemId, event: section.eventContext });
        },
      });
    },
    sidebarRemove: (sectionId) => {
      sidebarSectionsRegistry.remove(ext.id, sectionId);
    },
    onDomUnsupported: (surface) => {
      log("warn", [`${surface} is not available in the sandbox; use the declared manifest contributes instead`]);
    },
    log,
  };
}

/** Run a `"sandbox": "worker"` extension in a dedicated Web Worker. */
export async function activateSandboxed(
  ext: ExtensionRuntime,
  code: string,
): Promise<{ dispose: () => void }> {
  const worker = new Worker(new URL("./sandboxWorker.ts", import.meta.url), {
    type: "module",
  });
  const pendingToolCalls = new Map<number, Pending>();
  let callSeq = 1;

  function post(msg: unknown): void {
    worker.postMessage(msg);
  }

  const invokeTool = (name: string, args: unknown): Promise<unknown> => {
    const callId = callSeq++;
    const p = new Promise<unknown>((resolve, reject) =>
      pendingToolCalls.set(callId, { resolve, reject }),
    );
    post({
      type: "invoke_tool",
      name,
      args: (args ?? {}) as Record<string, unknown>,
      callId,
    });
    return p;
  };

  const invokeCommand = (id: string, args: unknown[]): Promise<unknown> => {
    const callId = callSeq++;
    const p = new Promise<unknown>((resolve, reject) =>
      pendingToolCalls.set(callId, { resolve, reject }),
    );
    post({ type: "invoke_command", id, args, callId });
    return p;
  };

  const executor = await buildExecutor(ext, { invokeTool, invokeCommand }, post);
  const dispatch = createSandboxDispatcher(
    { id: ext.id, declared: ext.manifest.permissions },
    executor,
  );

  let resolveReady: () => void = () => {};
  let rejectReady: (e: Error) => void = () => {};
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Host-side bound: if the worker never loads / imports / activates, surface
  // it. The worker's own activate guard fires activate_error, but a blob import
  // that hangs would otherwise leave the panel on "Loading panel..." forever.
  const readyTimeout = setTimeout(
    () => rejectReady(new Error("worker did not become ready within 12s")),
    12000,
  );

  worker.onerror = (e) => {
    clearTimeout(readyTimeout);
    rejectReady(new Error(`worker error: ${e.message ?? "unknown"}`));
  };

  worker.onmessage = (e) => {
    const data = e.data as { kind?: string; req?: SandboxRequest } | WorkerMessage;
    if (!data) return;
    // Worker -> host requests go through the permission dispatcher.
    if ((data as { kind?: string }).kind === "request") {
      const req = (data as { req: SandboxRequest }).req;
      void dispatch(req).then((resp) => worker.postMessage(resp));
      return;
    }
    const msg = data as WorkerMessage;
    if (msg.type === "ready") {
      clearTimeout(readyTimeout);
      resolveReady();
      return;
    }
    if (msg.type === "activate_error") {
      // Surface the failure so the user sees why a sandbox extension's panel
      // stays on \"Loading panel…\" without opening DevTools (disabled in
      // release builds).
      clearTimeout(readyTimeout);
      toast(`Extension \"${ext.id}\" failed to activate: ${msg.error}`, {
        variant: "error",
      });
      rejectReady(new Error(msg.error));
      return;
    }
    if (msg.type === "tool_result" || msg.type === "command_result") {
      const p = pendingToolCalls.get(msg.callId);
      if (p) {
        pendingToolCalls.delete(msg.callId);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      }
    }
  };

  post({ type: "init", id: ext.id, code });

  await readyPromise;

  return {
    dispose: () => {
      post({ type: "deactivate" });
      worker.terminate();
    },
  };
}
