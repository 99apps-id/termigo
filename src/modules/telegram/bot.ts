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
  callback_query?: {
    id: string;
    message?: { chat: { id: number }; message_id?: number };
    data?: string;
  };
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

async function sendKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineButton[][],
  signal: AbortSignal,
): Promise<void> {
  await apiPost(
    "sendMessage",
    { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } },
    signal,
  );
}

async function editKeyboard(
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineButton[][],
  signal: AbortSignal,
): Promise<void> {
  await apiPost(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: keyboard },
    },
    signal,
  );
}

async function answerCallback(
  callbackId: string,
  text: string | null,
  signal: AbortSignal,
): Promise<void> {
  await apiPost(
    "answerCallbackQuery",
    { callback_query_id: callbackId, text },
    signal,
  );
}

async function modelLabel(modelId: string): Promise<string> {
  const { MODELS, isCompatModelId, endpointIdFromCompatModel } = await import(
    "../ai/config"
  );
  const { usePreferencesStore } = await import(
    "@/modules/settings/preferences"
  );
  const m = MODELS.find((x) => x.id === modelId);
  if (m) return m.label;
  if (isCompatModelId(modelId)) {
    const eid = endpointIdFromCompatModel(modelId);
    const ep = usePreferencesStore
      .getState()
      .customEndpoints.find((e) => e.id === eid);
    return ep?.modelId || ep?.name || modelId;
  }
  return modelId;
}

async function buildStatus(): Promise<string> {
  const store = useTelegramStore.getState();
  const chat = await import("../ai/store/chatStore");
  const meta = chat.getAgentMeta();
  const model = chat.useChatStore.getState().selectedModelId;
  return [
    `Termigo bot ${store.online ? "online" : "offline"}`,
    `Model: ${await modelLabel(model)}`,
    `Agent: ${meta.status}`,
    `Enabled: ${store.enabled ? "yes" : "no"}`,
    store.lastError ? `Error: ${store.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

type InlineButton = { text: string; callback_data: string };
type ModelChoice = { id: string; label: string };
type ProviderGroup = { key: string; label: string; models: ModelChoice[] };

async function buildProviderGroups(): Promise<ProviderGroup[]> {
  const { MODELS, PROVIDERS, isCompatModelId, compatModelIdForEndpoint } =
    await import("../ai/config");
  const { usePreferencesStore } = await import(
    "@/modules/settings/preferences"
  );
  const chat = await import("../ai/store/chatStore");
  const state = chat.useChatStore.getState();
  const { buildModelGroups } = await import("./modelGroups");

  const providerLabel = (id: string): string => {
    if (id === "openai-compatible") return "OpenAI Compatible";
    return PROVIDERS.find((p) => p.id === id)?.label ?? id;
  };

  return buildModelGroups({
    models: MODELS,
    providerLabel,
    current: state.selectedModelId,
    apiKeys: state.apiKeys as Record<string, string | undefined>,
    customEndpointKeys: state.customEndpointKeys,
    customEndpoints: usePreferencesStore.getState().customEndpoints,
    isCompatModelId,
    compatModelIdForEndpoint,
  });
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
function statusLabel(status: string): string | null {
  switch (status) {
    case "thinking":
      return "Thinking…";
    case "streaming":
      return "Working…";
    case "awaiting-approval":
      return "Waiting for your approval…";
    default:
      return null;
  }
}

/** Compact, status-tracked todo block for Telegram (no emojis). */
function compactTodoBlock(
  items: { title: string; status: string }[],
): string | null {
  if (items.length === 0) return null;
  return `Todo:\n${items.map((t) => `- [${t.status}] ${t.title}`).join("\n")}`;
}

// One live progress publisher per chat, so a new task supersedes the previous
// run's stream instead of both posting updates.
const progressCtrls = new Map<number, AbortController>();

/**
 * Stream the agent's live progress (status, round, current step, todo list)
 * into the Telegram chat while the run is in flight. Stops when `signal`
 * aborts. Kept throttled so a fast agent does not spam the chat: at most one
 * message per ~3s, and only on meaningful change.
 */
async function publishProgress(
  chatId: number,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const store = await import("../ai/store/chatStore");
  const todosStore = await import("../ai/store/todoStore");
  const startMeta = store.useChatStore.getState().agentMeta;
  let lastStatus = startMeta.status;
  let lastRound = startMeta.round;
  let lastStep = startMeta.step ?? "";
  let lastTodoSig = "";
  let lastSentAt = 0;
  const started = Date.now();
  const MAX_WAIT = 30 * 60 * 1000;

  while (!signal.aborted && Date.now() - started < MAX_WAIT) {
    const meta = store.useChatStore.getState().agentMeta;
    const status = meta.status;
    const round = meta.round;
    const step = meta.step ?? "";
    const todos =
      todosStore.useTodosStore.getState().bySession[sessionId]?.items ?? [];
    const now = Date.now();

    if (status !== lastStatus) {
      lastStatus = status;
      const line = statusLabel(status);
      if (line) {
        await sendTelegram(chatId, line, signal).catch(() => {});
        lastSentAt = now;
      }
    }
    if (round > 0 && round !== lastRound) {
      lastRound = round;
      await sendTelegram(chatId, `Round ${round}`, signal).catch(() => {});
      lastSentAt = now;
    }
    if (step && step !== lastStep && now - lastSentAt >= 2500) {
      lastStep = step;
      await sendTelegram(chatId, `↳ ${step}`, signal).catch(() => {});
      lastSentAt = now;
    }
    const sig = todos.map((t) => `${t.status}|${t.title}`).join(";");
    if (todos.length > 0 && sig !== lastTodoSig && now - lastSentAt >= 3000) {
      lastTodoSig = sig;
      const block = compactTodoBlock(todos);
      if (block) await sendTelegram(chatId, block, signal).catch(() => {});
      lastSentAt = now;
    }

    await sleep(signal, 1200);
  }
}

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
    // Stream live progress alongside the run, superseding any prior stream.
    const progressCtl = new AbortController();
    progressCtrls.get(chatId)?.abort();
    progressCtrls.set(chatId, progressCtl);
    void publishProgress(chatId, sessionId, progressCtl.signal).catch(() => {});
    try {
      const reply = await waitForReply(store, signal, sessionId, baseline);
      await sendTelegram(chatId, reply, signal);
    } finally {
      progressCtl.abort();
      if (progressCtrls.get(chatId) === progressCtl) {
        progressCtrls.delete(chatId);
      }
    }
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
  "/query <question> — read-only question (or just type the question)",
  "/run <task> — run a task in the agent",
  "/stop — stop the current run",
  "/new — start a new agent session",
  "/model — pick a model (opens a provider → model menu)",
  "/model <id> — set the model directly",
  "/cost — today's & total spend",
].join("\n");

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

/** Mark the currently-selected model in the model keyboard with a check. */
function markModelButtons(
  models: ModelChoice[],
  current: string,
): InlineButton[][] {
  return models.map((m) => [
    {
      text: m.id === current ? `✓ ${m.label}` : m.label,
      callback_data: `ms:${m.id}`,
    },
  ]);
}

/** Answer an inline-keyboard callback from the /model menu. */
async function handleCallback(
  cb: NonNullable<Update["callback_query"]>,
  signal: AbortSignal,
): Promise<void> {
  const data = cb.data ?? "";
  const msg = cb.message;
  if (!msg?.message_id) {
    await answerCallback(cb.id, null, signal);
    return;
  }
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  if (data.startsWith("mp:")) {
    const key = data.slice(3);
    const groups = await buildProviderGroups();
    const group = groups.find((g) => g.key === key);
    if (!group) {
      await answerCallback(
        cb.id,
        "That provider is no longer available.",
        signal,
      );
      return;
    }
    await answerCallback(cb.id, null, signal);
    const state = await import("../ai/store/chatStore");
    const current = state.useChatStore.getState().selectedModelId;
    await editKeyboard(
      chatId,
      messageId,
      `Pick a model for ${group.label}:`,
      markModelButtons(group.models, current),
      signal,
    );
    return;
  }

  if (data.startsWith("ms:")) {
    const model = data.slice(3);
    if (!(await isValidModel(model))) {
      await answerCallback(cb.id, "Unknown model.", signal);
      return;
    }
    const state = await import("../ai/store/chatStore");
    state.useChatStore.getState().setSelectedModelId(model);
    await answerCallback(cb.id, `Model set to ${model}`, signal);
    await editKeyboard(chatId, messageId, `Model set to ${model}.`, [], signal);
    return;
  }

  await answerCallback(cb.id, null, signal);
}

async function handleUpdate(u: Update, signal: AbortSignal): Promise<void> {
  // Inline-keyboard taps from the /model menu come through as callback_query.
  if (u.callback_query) {
    await handleCallback(u.callback_query, signal);
    return;
  }
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
      await sendTelegram(chatId, "Started — I'll post progress here.", signal);
      void dispatchAndStream(tail, chatId, signal);
      return;
    }
    case "/run": {
      if (!tail)
        return void (await sendTelegram(chatId, "Usage: /run <task>", signal));
      await sendTelegram(
        chatId,
        "Task submitted — I'll post progress here.",
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
        // Interactive picker: providers first, then a model per provider. Only
        // providers the user can actually reach (plus the current one) appear.
        const current = state.useChatStore.getState().selectedModelId;
        const groups = await buildProviderGroups();
        const keyboard = groups.map((g) => [
          { text: g.label, callback_data: `mp:${g.key}` },
        ]);
        if (keyboard.length === 0) {
          await sendTelegram(
            chatId,
            `Current model: ${current}\n\nNo other providers are configured.`,
            signal,
          );
          return;
        }
        await sendKeyboard(
          chatId,
          `Current model: ${current}\n\nChoose a provider:`,
          keyboard,
          signal,
        );
        return;
      }
      if (!(await isValidModel(tail))) {
        await sendTelegram(
          chatId,
          `Unknown model '${tail}'. Send /model for the picker.`,
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
      // A bare message is a question/task — no /query prefix needed. Unknown
      // slash commands still get help so a typo isn't silently sent to the app.
      if (text.startsWith("/")) {
        await sendTelegram(chatId, HELP, signal);
        return;
      }
      await sendTelegram(
        chatId,
        "Started — working on it; progress will show here.",
        signal,
      );
      void dispatchAndStream(text, chatId, signal);
      return;
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
