// Host side of the sandboxed extension execution.
//
// Creates the Web Worker for a `"sandbox": "worker"` extension, drives the RPC,
// and enforces permissions through `createSandboxDispatcher`. When the worker
// registers an AI tool or command handler, we set a bridge handler in the
// registry so the agent / command palette can invoke it (the worker holds the
// real handler and replies over the message channel).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import * as chatMod from "@/modules/ai/store/chatStore";
import { aiToolsRegistry, commandsRegistry } from "./registries";
import type { ExtensionRuntime } from "./host";
import {
  createSandboxDispatcher,
  type SandboxExecutor,
  type SandboxRequest,
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

  const executor = await buildExecutor(ext, { invokeTool, invokeCommand });
  const dispatch = createSandboxDispatcher(
    { id: ext.id, declared: ext.manifest.permissions },
    executor,
  );

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

  return {
    dispose: () => {
      post({ type: "deactivate" });
      worker.terminate();
    },
  };
}
