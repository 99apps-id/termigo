// Telegram bot relay — drives Termigo's in-app agent via the normal chat
// path (`sendMessage`), so the bot behaves exactly like typing in the app.
//
// The bot long-polls the Telegram Bot API from the webview (CSP already allows
// `https:`). It only runs while the app is open, which is what a desktop relay
// wants. Structure is complete; /query and /run submit a task and ack, and a
// later enhancement can stream the final answer back.

import { getTelegramToken } from "./keyring";
import { useTelegramStore } from "./store";

const API = "https://api.telegram.org";

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

async function dispatchToAgent(text: string): Promise<void> {
  const chat = await import("../ai/store/chatRuntime");
  const state = await import("../ai/store/chatStore");
  if (!state.useChatStore.getState().activeSessionId) {
    state.useChatStore.getState().newSession();
  }
  await chat.sendMessage(text);
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
    case "/query": {
      if (!tail)
        return void (await sendTelegram(
          chatId,
          "Usage: /query <question>",
          signal,
        ));
      await sendTelegram(chatId, "Running query in the app…", signal);
      await dispatchToAgent(tail);
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
      await dispatchToAgent(tail);
      return;
    }
    default:
      await sendTelegram(
        chatId,
        "Unknown command. Try /status, /query <question>, /run <task>.",
        signal,
      );
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
