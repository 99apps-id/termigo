// Telegram bot relay — drives Termigo's in-app agent via the normal chat
// path (`sendMessage`), so the bot behaves exactly like typing in the app.
//
// The bot long-polls the Telegram Bot API from the webview (CSP already allows
// `https:`). It only runs while the app is open, which is what a desktop relay
// wants. /query and /run submit a task, ack immediately, then stream the
// agent's final answer back to the chat once the run settles.

import { getTelegramToken } from "./keyring";
import { useTelegramStore } from "./store";

const API = "https://api.telegram.org";

/** Minimal view of a chat + its messages, so we read the final answer without
 *  pulling the full AI SDK types into this module. */
type ChatLike = {
  status?: string;
  messages: Array<{
    role: string;
    parts?: Array<{ type?: string; text?: string }>;
  }>;
};

type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
};

let loopController: AbortController | null = null;

async function apiGet(path: string, signal: AbortSignal): Promise<unknown> {
  const token = await getTelegramToken();
  if (!token) throw new Error("No Telegram token configured");
  const res = await fetch(`${API}/bot${token}/${path}`, { signal });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function apiPost(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const token = await getTelegramToken();
  if (!token) throw new Error("No Telegram token configured");
  const res = await fetch(`${API}/bot${token}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

async function sendTelegram(
  chatId: number,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost("sendMessage", { chat_id: chatId, text }, signal);
}

async function buildStatus(): Promise<string> {
  const store = useTelegramStore.getState();
  const chat = await import("../ai/store/chatStore");
  const meta = chat.getAgentMeta();
  const model = chat.useChatStore.getState().selectedModelId;
  return [
    `Termigo bot ${store.online ? "online" : "offline"}`,
    `Model: ${model}`,
    `Agent: ${meta.status}`,
    `Enabled: ${store.enabled ? "yes" : "no"}`,
    store.lastError ? `Error: ${store.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Number of assistant messages in a session (used as a baseline to detect a
 *  fresh answer after our dispatch). */
function countAssistantMessages(
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
): number {
  const chat = getChat(sessionId);
  return chat ? chat.messages.filter((m) => m.role === "assistant").length : 0;
}

/** Extract the final assistant text, considering only assistant messages newer
 *  than the `sinceCount` baseline captured before the dispatch. */
function lastAssistantText(
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
  sinceCount: number,
): string | null {
  const chat = getChat(sessionId);
  if (!chat) return null;
  const assistants = chat.messages.filter((m) => m.role === "assistant");
  const relevant = assistants.slice(sinceCount);
  if (relevant.length === 0) return null;
  const last = relevant[relevant.length - 1];
  const text = (last.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return text.trim() || null;
}

function runBusy(chatStatus: string, appStatus: string): boolean {
  return (
    chatStatus === "submitted" ||
    chatStatus === "streaming" ||
    appStatus === "thinking" ||
    appStatus === "streaming" ||
    appStatus === "awaiting-approval"
  );
}

/**
 * Wait until the dispatched run produces a fresh assistant answer and settles.
 * Returns the text to send back, or a short status line when nothing came.
 */
async function waitForReply(
  store: typeof import("../ai/store/chatStore"),
  signal: AbortSignal,
  sessionId: string,
  baseline: number,
): Promise<string> {
  const started = Date.now();
  const MAX_WAIT = 30 * 60 * 1000;
  while (!signal.aborted && Date.now() - started < MAX_WAIT) {
    const appStatus = store.useChatStore.getState().agentMeta.status;
    const chatStatus = store.getChat(sessionId)?.status ?? "";
    const busy = runBusy(chatStatus, appStatus);
    const count = countAssistantMessages(store.getChat, sessionId);
    const queued = store.useChatStore.getState().steerQueue.pending.length > 0;

    if (count > baseline) {
      // A fresh answer exists; send it once the run has settled and nothing is
      // still queued behind our message.
      if (!busy && !queued) {
        return (
          lastAssistantText(store.getChat, sessionId, baseline) ??
          "Run finished."
        );
      }
    } else if (!busy && Date.now() - started > 25_000) {
      // Never produced a new assistant message — likely a refusal/error.
      const err = store.useChatStore.getState().agentMeta.error;
      return err
        ? `Run ended with an error: ${err}`
        : "Run produced no text output.";
    }
    await sleep(signal, 1500);
  }
  return "Run is still in progress or waiting for approval in Termigo — the result is not streamed here.";
}

/**
 * Submit a task to the in-app agent and stream its final answer back to the
 * calling Telegram chat. Runs in the background so the long-poll stays open.
 */
async function dispatchAndStream(
  text: string,
  chatId: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    const store = await import("../ai/store/chatStore");
    const runtime = await import("../ai/store/chatRuntime");
    if (!store.useChatStore.getState().activeSessionId) {
      store.useChatStore.getState().newSession();
    }
    const sessionId = store.useChatStore.getState().activeSessionId;
    if (!sessionId) return;
    const baseline = countAssistantMessages(store.getChat, sessionId);
    const accepted = await runtime.sendMessage(text);
    if (!accepted) {
      await sendTelegram(
        chatId,
        "Could not start the agent run — check the model / API key.",
        signal,
      );
      return;
    }
    const reply = await waitForReply(store, signal, sessionId, baseline);
    await sendTelegram(chatId, reply, signal);
  } catch (e) {
    if (signal.aborted) return;
    await sendTelegram(
      chatId,
      `Error during run: ${e instanceof Error ? e.message : String(e)}`,
      signal,
    ).catch(() => {});
  }
}

const HELP = [
  "/status — bot + agent status",
  "/query <question> — read-only question",
  "/run <task> — run a task in the agent",
  "/stop — stop the current run",
  "/new — start a new agent session",
  "/model [id] — show or set the model",
  "/cost — today's & total spend",
].join("\n");

async function listModelChoices(): Promise<string[]> {
  const { MODELS, compatModelIdForEndpoint } = await import("../ai/config");
  const { usePreferencesStore } = await import(
    "@/modules/settings/preferences"
  );
  const builtin = MODELS.map((m) => m.id);
  const custom = usePreferencesStore
    .getState()
    .customEndpoints.map((ep) => compatModelIdForEndpoint(ep.id));
  return [...builtin, ...custom];
}

async function isValidModel(id: string): Promise<boolean> {
  const { MODELS, isCompatModelId, compatModelIdForEndpoint } = await import(
    "../ai/config"
  );
  const { usePreferencesStore } = await import(
    "@/modules/settings/preferences"
  );
  if (MODELS.some((m) => m.id === id)) return true;
  if (!isCompatModelId(id)) return false;
  return usePreferencesStore
    .getState()
    .customEndpoints.some((ep) => compatModelIdForEndpoint(ep.id) === id);
}

async function handleUpdate(u: Update, signal: AbortSignal): Promise<void> {
  const msg = u.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const owner = useTelegramStore.getState().chatId;
  if (owner && String(owner) !== String(chatId)) return;

  const text = msg.text.trim();
  const [head, ...rest] = text.split(/\s+/);
  const tail = rest.join(" ").trim();

  switch (head) {
    case "/status":
      await sendTelegram(chatId, await buildStatus(), signal);
      return;
    case "/help":
      await sendTelegram(chatId, HELP, signal);
      return;
    case "/query": {
      if (!tail)
        return void (await sendTelegram(
          chatId,
          "Usage: /query <question>",
          signal,
        ));
      await sendTelegram(chatId, "Running query in the app…", signal);
      void dispatchAndStream(tail, chatId, signal);
      return;
    }
    case "/run": {
      if (!tail)
        return void (await sendTelegram(chatId, "Usage: /run <task>", signal));
      await sendTelegram(
        chatId,
        "Task submitted — the agent works in the app.",
        signal,
      );
      void dispatchAndStream(tail, chatId, signal);
      return;
    }
    case "/stop": {
      const runtime = await import("../ai/store/chatRuntime");
      await runtime.stopRun();
      await sendTelegram(
        chatId,
        "Stop requested — the current run will settle.",
        signal,
      );
      return;
    }
    case "/new": {
      const state = await import("../ai/store/chatStore");
      state.useChatStore.getState().newSession();
      await sendTelegram(chatId, "New agent session started.", signal);
      return;
    }
    case "/model": {
      const state = await import("../ai/store/chatStore");
      if (!tail) {
        const current = state.useChatStore.getState().selectedModelId;
        const ids = await listModelChoices();
        await sendTelegram(
          chatId,
          `Current: ${current}\n\n${ids.join("\n")}`,
          signal,
        );
        return;
      }
      if (!(await isValidModel(tail))) {
        await sendTelegram(
          chatId,
          `Unknown model '${tail}'. Send /model for the list.`,
          signal,
        );
        return;
      }
      state.useChatStore.getState().setSelectedModelId(tail);
      await sendTelegram(chatId, `Model set to ${tail}.`, signal);
      return;
    }
    case "/cost": {
      const { costToday, loadCostLedger, sumCost } = await import(
        "../ai/lib/costLedger"
      );
      const today = await costToday();
      const total = sumCost(await loadCostLedger());
      await sendTelegram(
        chatId,
        `Cost today: $${today.toFixed(4)}\nTotal recorded: $${total.toFixed(4)}`,
        signal,
      );
      return;
    }
    default:
      await sendTelegram(chatId, HELP, signal);
  }
}

async function runLoop(signal: AbortSignal): Promise<void> {
  let myOffset = 0;
  while (!signal.aborted && useTelegramStore.getState().enabled) {
    try {
      const data = (await apiGet(
        `getUpdates?offset=${myOffset}&timeout=30`,
        signal,
      )) as { ok: boolean; result: Update[] };
      useTelegramStore.getState().setOnline(true);
      useTelegramStore.getState().setLastError(null);
      for (const u of data.result ?? []) {
        myOffset = Math.max(myOffset, u.update_id + 1);
        await handleUpdate(u, signal);
      }
    } catch (e) {
      if (signal.aborted) break;
      useTelegramStore.getState().setOnline(false);
      useTelegramStore
        .getState()
        .setLastError(e instanceof Error ? e.message : String(e));
      await sleep(signal, 5000);
    }
  }
  useTelegramStore.getState().setOnline(false);
}

/** Start the long-polling loop (idempotent). */
export function startTelegramBot(): void {
  if (loopController) return;
  const controller = new AbortController();
  loopController = controller;
  useTelegramStore.getState().setOnline(true);
  useTelegramStore.getState().setLastError(null);
  void runLoop(controller.signal);
}

/** Stop the long-polling loop. */
export function stopTelegramBot(): void {
  loopController?.abort();
  loopController = null;
  useTelegramStore.getState().setOnline(false);
}
