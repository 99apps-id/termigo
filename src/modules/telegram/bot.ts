// Telegram bot relay - drives Termigo's in-app agent via the normal chat
// path (`sendMessage`), so the bot behaves exactly like typing in the app.
//
// The bot long-polls the Telegram Bot API from the webview (CSP already allows
// `https:`). It only runs while the app is open, which is what a desktop relay
// wants. /query and /run submit a task, ack immediately, then stream the
// agent's final answer back to the chat once the run settles.

import { getTelegramToken } from "./keyring";
import { markdownToTelegramHtml, summarizeToolInput } from "./progressFormat";
import { useTelegramStore } from "./store";

const API = "https://api.telegram.org";

/** Minimal view of a chat + its messages, so we read the final answer without
 *  pulling the full AI SDK types into this module. */
type ChatLike = {
  status?: string;
  messages: Array<{
    id?: string;
    role: string;
    parts?: Array<{
      type?: string;
      text?: string;
      toolName?: string;
      output?: unknown;
      input?: unknown;
      state?: string;
      approval?: { id?: string };
      approvalId?: string;
      id?: string;
    }>;
  }>;
};

type Update = {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: { id: number };
    message?: { chat: { id: number }; message_id?: number };
    data?: string;
  };
};

let loopController: AbortController | null = null;
let mirrorController: AbortController | null = null;

// Set while the bot is relaying a Telegram-initiated dispatch, so the Termigo ->
// Telegram mirror stays quiet (the bot posts the run's own answer) instead of
// double-posting the injected user message and the assistant reply. A counter,
// not a boolean: dispatches can overlap (the long-poll keeps running while one
// is in flight), so each dispatch holds one pause.
let mirrorPauseCount = 0;
function pauseMirror(): void {
  mirrorPauseCount += 1;
}
function resumeMirror(): void {
  mirrorPauseCount = Math.max(0, mirrorPauseCount - 1);
}

const seenMessageIds = new Set<string>();
const seenFingerprints = new Set<string>();
const telegramOriginMessageIds = new Set<string>();
const recentTelegramPrompts = new Map<string, number>();
const sentApprovalIds = new Set<string>();

function recordTelegramText(text: string): void {
  const norm = text.trim();
  if (!norm) return;
  recentTelegramPrompts.set(norm, Date.now());
  const now = Date.now();
  if (recentTelegramPrompts.size > 50) {
    for (const [k, ts] of recentTelegramPrompts) {
      if (now - ts > 10 * 60 * 1000) recentTelegramPrompts.delete(k);
    }
  }
}

function isTelegramOriginText(text: string): boolean {
  const norm = text.trim();
  if (!norm) return false;
  const ts = recentTelegramPrompts.get(norm);
  if (!ts) return false;
  if (Date.now() - ts < 10 * 60 * 1000) return true;
  recentTelegramPrompts.delete(norm);
  return false;
}

function markMessageSeen(
  id: string | undefined,
  sessionId: string,
  role: string,
  text: string,
): void {
  if (id) {
    seenMessageIds.add(id);
    if (seenMessageIds.size > 2000) {
      for (const item of seenMessageIds) {
        seenMessageIds.delete(item);
        break;
      }
    }
  }
  const fp = `${sessionId}:${role}:${id ?? text.slice(0, 80)}`;
  seenFingerprints.add(fp);
  if (seenFingerprints.size > 2000) {
    for (const item of seenFingerprints) {
      seenFingerprints.delete(item);
      break;
    }
  }
}

function isMessageSeen(
  id: string | undefined,
  sessionId: string,
  role: string,
  text: string,
): boolean {
  if (id && seenMessageIds.has(id)) return true;
  const fp = `${sessionId}:${role}:${id ?? text.slice(0, 80)}`;
  return seenFingerprints.has(fp);
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly description: string;
  readonly retryAfter?: number;

  constructor(status: number, description: string, retryAfter?: number) {
    super(`Telegram API ${status}: ${description}`);
    this.name = "TelegramApiError";
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

function mergeSignals(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => {
    ctrl.abort(new Error(`Timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const onParentAbort = () => {
    ctrl.abort(parent.reason);
  };

  if (parent.aborted) {
    ctrl.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(t);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

async function parseTelegramError(res: Response): Promise<TelegramApiError> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as {
      ok?: boolean;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    const desc = json.description || text.slice(0, 200) || res.statusText;
    const retryAfter = json.parameters?.retry_after;
    return new TelegramApiError(res.status, desc, retryAfter);
  } catch {
    return new TelegramApiError(
      res.status,
      text.slice(0, 200) || res.statusText,
    );
  }
}

async function apiGet(
  path: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<unknown> {
  const token = await getTelegramToken();
  if (!token) throw new Error("No Telegram token configured");
  const { signal: reqSignal, cleanup } = mergeSignals(signal, timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${path}`, { signal: reqSignal });
    if (!res.ok) {
      throw await parseTelegramError(res);
    }
    return await res.json();
  } finally {
    cleanup();
  }
}

async function apiPost(
  path: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<unknown> {
  const token = await getTelegramToken();
  if (!token) throw new Error("No Telegram token configured");
  const { signal: reqSignal, cleanup } = mergeSignals(signal, timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: reqSignal,
    });
    if (!res.ok) {
      throw await parseTelegramError(res);
    }
    return await res.json();
  } finally {
    cleanup();
  }
}

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
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

/** Split long messages on newline/word boundaries so nothing is truncated. */
function splitTelegramText(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) {
      cut = remaining.lastIndexOf(" ", maxLen);
    }
    if (cut <= 0) {
      cut = maxLen;
    }
    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

async function sendTelegram(
  chatId: number | string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const chunks = splitTelegramText(text);
  for (const chunk of chunks) {
    if (signal.aborted) break;
    const html = markdownToTelegramHtml(chunk);
    try {
      await apiPost(
        "sendMessage",
        { chat_id: chatId, text: html, parse_mode: "HTML" },
        signal,
      );
    } catch {
      await apiPost("sendMessage", { chat_id: chatId, text: chunk }, signal);
    }
  }
}

async function sendProgressMessage(
  chatId: number | string,
  text: string,
  signal: AbortSignal,
): Promise<number | null> {
  const html = markdownToTelegramHtml(text);
  try {
    const res = (await apiPost(
      "sendMessage",
      { chat_id: chatId, text: html, parse_mode: "HTML" },
      signal,
    )) as { ok?: boolean; result?: { message_id?: number } };
    return res?.result?.message_id ?? null;
  } catch {
    try {
      const res = (await apiPost(
        "sendMessage",
        { chat_id: chatId, text },
        signal,
      )) as { ok?: boolean; result?: { message_id?: number } };
      return res?.result?.message_id ?? null;
    } catch {
      return null;
    }
  }
}

async function editProgressMessage(
  chatId: number | string,
  messageId: number,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  const html = markdownToTelegramHtml(text);
  const tryPost = async (body: { text: string; parse_mode?: string }) => {
    return (await apiPost(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        ...body,
      },
      signal,
      10_000,
    )) as { ok?: boolean };
  };

  try {
    await tryPost({ text: html, parse_mode: "HTML" });
    return true;
  } catch (err) {
    if (err instanceof TelegramApiError) {
      const desc = err.description.toLowerCase();
      // Exact message already displayed on Telegram: treat as success (Hermes pattern)
      if (desc.includes("message is not modified")) {
        return true;
      }
      // Rate limited: if retry_after is small (<=3s), back off briefly, else skip intermediate progress
      if (err.status === 429) {
        const waitSec = err.retryAfter ?? 2;
        if (waitSec <= 3 && !signal.aborted) {
          await sleep(signal, waitSec * 1000);
          try {
            await tryPost({ text: html, parse_mode: "HTML" });
            return true;
          } catch (retryErr) {
            if (
              retryErr instanceof TelegramApiError &&
              retryErr.description
                .toLowerCase()
                .includes("message is not modified")
            ) {
              return true;
            }
            return false;
          }
        }
        return false;
      }
    }
    // Fallback to plain text if HTML entity parsing fails
    try {
      await tryPost({ text });
      return true;
    } catch (fallbackErr) {
      if (
        fallbackErr instanceof TelegramApiError &&
        fallbackErr.description
          .toLowerCase()
          .includes("message is not modified")
      ) {
        return true;
      }
      return false;
    }
  }
}

async function deleteTelegramMessage(
  chatId: number | string,
  messageId: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await apiPost(
      "deleteMessage",
      { chat_id: chatId, message_id: messageId },
      signal ?? AbortSignal.timeout(4000),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Show the "typing..." bubble in the Telegram chat. The bubble lasts ~5s, so a
 * caller re-sends it on an interval while the agent is busy.
 */
async function sendTyping(
  chatId: number | string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost(
    "sendChatAction",
    { chat_id: chatId, action: "typing" },
    signal,
  );
}

/** Multipart POST - Telegram uploads photos/documents via form-data, not JSON. */
async function apiPostForm(
  path: string,
  form: FormData,
  signal: AbortSignal,
  timeoutMs = 45_000,
): Promise<unknown> {
  const token = await getTelegramToken();
  if (!token) throw new Error("No Telegram token configured");
  const { signal: reqSignal, cleanup } = mergeSignals(signal, timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${path}`, {
      method: "POST",
      body: form,
      signal: reqSignal,
    });
    if (!res.ok) {
      throw await parseTelegramError(res);
    }
    return await res.json();
  } finally {
    cleanup();
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(dataUrl.split(",")[1] ?? "");
}

/** Send a PNG (as a data URL) as a photo. Used for rasterised Mermaid. */
async function sendPhoto(
  chatId: number | string,
  dataUrl: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "photo",
    new Blob([dataUrlToBytes(dataUrl)], { type: "image/png" }),
    "diagram.png",
  );
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendPhoto", form, signal);
}

/** Send raw bytes as a document (PDF, HTML, Markdown, image…). */
async function sendDocument(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  // Copy to an ArrayBuffer-backed view; Blob rejects a generic Uint8Array.
  const copy = new Uint8Array(bytes);
  form.append("document", new Blob([copy]), filename);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendDocument", form, signal);
}

async function sendKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineButton[][],
  signal: AbortSignal,
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await apiPost(
      "sendMessage",
      {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      },
      signal,
    );
  } catch {
    await apiPost(
      "sendMessage",
      { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } },
      signal,
    );
  }
}

async function editKeyboard(
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineButton[][],
  signal: AbortSignal,
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await apiPost(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      },
      signal,
    );
  } catch {
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
    `Paired: ${store.chatId ? `yes (ID: ${store.chatId})` : "no (open to all chats)"}`,
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

export type PendingApprovalInfo = {
  id: string;
  toolName: string;
  summary: string;
  source: "sdk" | "queue";
};

export function getPendingApprovals(
  sessionId: string,
  chatStore?: any,
  aqStore?: any,
): PendingApprovalInfo[] {
  const result: PendingApprovalInfo[] = [];
  const seen = new Set<string>();

  // 1. Direct scan from active Chat instance
  if (chatStore && sessionId) {
    const chatGetter =
      typeof chatStore.getChat === "function" ? chatStore.getChat : null;
    const chat = chatGetter ? chatGetter(sessionId) : null;
    if (chat) {
      for (const m of chat.messages) {
        if (m.role !== "assistant") continue;
        for (const p of m.parts ?? []) {
          const part = p as {
            state?: string;
            type?: string;
            toolName?: string;
            input?: unknown;
            approval?: { id?: string };
            approvalId?: string;
            id?: string;
          };
          if (part.state === "approval-requested") {
            const id = part.approval?.id || part.approvalId || part.id;
            if (id && !seen.has(id)) {
              seen.add(id);
              const toolName =
                typeof part.toolName === "string" && part.toolName
                  ? part.toolName
                  : (part.type ?? "").replace(/^tool-/, "") || "tool";
              const summary = summarizeToolInput(toolName, part.input);
              result.push({ id, toolName, summary, source: "sdk" });
            }
          }
        }
      }
    }

    // 2. ChatStore agentMeta.pendingApprovals (populated by AgentRunBridge)
    const chatState =
      typeof chatStore.getState === "function"
        ? chatStore.getState()
        : chatStore.useChatStore?.getState?.();
    const metaPending = chatState?.agentMeta?.pendingApprovals ?? [];
    for (const p of metaPending) {
      if (p.id && !seen.has(p.id)) {
        seen.add(p.id);
        result.push({
          id: p.id,
          toolName: p.toolName,
          summary: p.summary,
          source: "sdk",
        });
      }
    }
  }

  // 3. Approval queue store
  if (aqStore) {
    const queueState =
      typeof aqStore.getState === "function"
        ? aqStore.getState()
        : aqStore.useApprovalQueue?.getState?.();
    const queuePending = queueState?.pending ?? [];
    for (const q of queuePending) {
      if (q.id && !seen.has(q.id)) {
        seen.add(q.id);
        result.push({
          id: q.id,
          toolName: q.toolName,
          summary: q.summary,
          source: "queue",
        });
      }
    }
  }

  return result;
}

function runBusy(
  chatStatus: string,
  appStatus: string,
  hasPendingApproval = false,
): boolean {
  return (
    hasPendingApproval ||
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
  let everBusy = false;
  const aqStore = await import("../ai/store/approvalQueueStore");
  while (!signal.aborted && Date.now() - started < MAX_WAIT) {
    const appStatus = store.useChatStore.getState().agentMeta.status;
    const chatStatus = store.getChat(sessionId)?.status ?? "";
    const pending = getPendingApprovals(sessionId, store, aqStore);
    const busy = runBusy(chatStatus, appStatus, pending.length > 0);
    if (busy) everBusy = true;
    const count = countAssistantMessages(store.getChat, sessionId);

    if (count > baseline) {
      // A fresh answer exists; send it once the run has settled.
      if (!busy) {
        return (
          lastAssistantText(store.getChat, sessionId, baseline) ??
          "Run finished."
        );
      }
    } else {
      const err = store.useChatStore.getState().agentMeta.error;
      if (err) {
        return `Run ended with an error: ${err}`;
      }
      if (everBusy && !busy) {
        return "Run produced no text output.";
      }
      if (!busy && Date.now() - started > 25_000) {
        return "Run produced no text output.";
      }
    }
    await sleep(signal, 1500);
  }
  return "Run is still in progress or waiting for approval. Use Telegram inline buttons or /status to check.";
}

// One live progress publisher per chat, so a new task supersedes the previous
// run's stream instead of both posting updates.
const progressCtrls = new Map<number, AbortController>();
// Track the last finished progress message per chat so it can be cleared when a new task starts.
const lastFinishedProgressMessageIds = new Map<number, number>();

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
  initialText?: string,
  mode: "task" | "question" = "task",
): Promise<void> {
  const store = await import("../ai/store/chatStore");
  const todosStore = await import("../ai/store/todoStore");
  const { extractToolSummaries, formatLiveProgress, resolveModelLabel } = await import(
    "./progressFormat"
  );
  let progressMessageId: number | null = null;
  let lastLiveText = "";
  let lastSentAt = 0;
  let lastTypingAt = 0;
  let lastLiveTextPokeAt = 0;
  const sentElicitationIds = new Set<string>();
  const started = Date.now();
  const MAX_WAIT = 30 * 60 * 1000;

  if (mode === "question") {
    return;
  }

  if (initialText) {
    progressMessageId = await sendProgressMessage(chatId, initialText, signal);
    lastLiveText = initialText;
    lastSentAt = Date.now();
    lastTypingAt = Date.now();
    await sendTyping(chatId, signal).catch(() => {});
  }

  try {
    while (!signal.aborted && Date.now() - started < MAX_WAIT) {
      const meta = store.useChatStore.getState().agentMeta;
      const status = meta.status;
      const step = meta.step ?? "";
      const todos =
        todosStore.useTodosStore.getState().bySession[sessionId]?.items ?? [];
      const now = Date.now();

      // Keep the "typing..." bubble alive while the run is busy (thinking,
      // streaming, or awaiting approval).
      const chat = store.getChat(sessionId);
      const chatStatus = chat?.status ?? "";
      const aqStore = await import("../ai/store/approvalQueueStore");
      const pendingApprovals = getPendingApprovals(sessionId, store, aqStore);
      const busy =
        runBusy(chatStatus, status, pendingApprovals.length > 0) ||
        status === "thinking" ||
        status === "streaming" ||
        status === "awaiting-approval" ||
        progressMessageId === null;

      if (busy && now - lastTypingAt >= 3000) {
        lastTypingAt = now;
        await sendTyping(chatId, signal).catch(() => {});
      }

      // Collect tool parts from the active assistant message
      const messages = chat?.messages ?? [];
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const toolSummaries = lastAssistant?.parts
        ? extractToolSummaries(lastAssistant.parts)
        : [];

      // Format compact live progress
      const liveStatus =
        pendingApprovals.length > 0
          ? "awaiting-approval"
          : status === "idle" && busy
            ? "thinking"
            : status;
      const liveText = formatLiveProgress({
        status: liveStatus,
        round: meta.round,
        step,
        tools: toolSummaries,
        todos,
        elapsedMs: now - started,
        mode,
        modelLabel: await resolveModelLabel(
          store.useChatStore.getState().selectedModelId,
        ),
      });

      if (!progressMessageId) {
        progressMessageId = await sendProgressMessage(chatId, liveText, signal);
        lastLiveText = liveText;
        lastSentAt = now;
        lastTypingAt = now;
        // Telegram client clears typing indicator when a message is received; re-send typing immediately.
        await sendTyping(chatId, signal).catch(() => {});
      } else if (liveText !== lastLiveText && now - lastSentAt >= 1500) {
        lastLiveText = liveText;
        await editProgressMessage(chatId, progressMessageId, liveText, signal);
        lastSentAt = now;
      } else if (
        // Heartbeat: even when the live text is unchanged (a long-running tool /
        // model wait with no new step or tool trail), keep poking the bubble so
        // the run never reads as frozen. The typing action is transient in
        // Telegram and clears on any inbound message, so this keeps a visible
        // "working" signal during long steps.
        busy &&
        now - lastLiveTextPokeAt >= 5000
      ) {
        lastLiveTextPokeAt = now;
        // Re-send the bubble; also refresh the progress text with the live
        // status so it visibly ticks even when the tool trail is empty.
        await sendTyping(chatId, signal).catch(() => {});
        await editProgressMessage(chatId, progressMessageId, liveText, signal)
          .catch(() => {});
      }

      // Surface pending approvals as interactive inline buttons in Telegram
      for (const p of pendingApprovals) {
        if (!sentApprovalIds.has(p.id)) {
          sentApprovalIds.add(p.id);
          const prefix = p.source === "queue" ? "aq" : "ap";
          const keyboard: InlineButton[][] = [
            [
              { text: "Approve", callback_data: `${prefix}:approve:${p.id}` },
              { text: "Deny", callback_data: `${prefix}:deny:${p.id}` },
            ],
            [
              { text: "Allow session", callback_data: `${prefix}:session:${p.id}` },
              { text: "Allow always", callback_data: `${prefix}:always:${p.id}` },
            ],
          ];
          await sendKeyboard(
            chatId,
            `Action Approval Required:\nTool: ${p.toolName}\nTarget: ${p.summary || p.toolName}\n(Reply /approve or /deny)`,
            keyboard,
            signal,
          ).catch(() => {});
          lastSentAt = now;
        }
      }

      // Surface questions from ask_user (elicitation)
      const elStore = await import("../ai/store/elicitationStore");
      const elPending = elStore.useElicitationStore.getState().pending;
      for (const el of elPending) {
        if (!sentElicitationIds.has(el.id)) {
          sentElicitationIds.add(el.id);
          const keyboard: InlineButton[][] = el.options
            .slice(0, 6)
            .map((opt, i) => [
              { text: opt.slice(0, 40), callback_data: `el:${el.id}:${i}` },
            ]);
          await sendKeyboard(
            chatId,
            `Agent Question:\n${el.question}`,
            keyboard,
            signal,
          ).catch(() => {});
          lastSentAt = now;
        }
      }

      await sleep(signal, 1000);
    }
  } finally {
    if (progressMessageId) {
      const doneText = formatLiveProgress({ status: "idle", completed: true });
      await editProgressMessage(
        chatId,
        progressMessageId,
        doneText,
        AbortSignal.timeout(4000),
      ).catch(() => {});
      lastFinishedProgressMessageIds.set(chatId, progressMessageId);
    }
  }
}

function messageText(m: {
  role: string;
  parts?: Array<{ type?: string; text?: string }>;
}): string {
  const text = (m.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return text.trim();
}

/** Telegram caps a message at 4096 chars; chunking is preferred over lossy clamping. */
function clampTelegramText(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

/**
 * Send a reply plus any Mermaid blocks rendered to PNG, so a diagram the agent
 * produced actually shows in Telegram instead of as raw source. Text is sent
 * first (never dropped); diagrams are best-effort after it.
 */
async function sendReplyWithDiagrams(
  chatId: number | string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  await sendTelegram(chatId, text, signal);
  const { extractMermaidBlocks, renderMermaidToPng } = await import(
    "./mermaidImage"
  );
  const blocks = extractMermaidBlocks(text);
  for (const block of blocks) {
    const png = await renderMermaidToPng(block);
    if (png) {
      await sendPhoto(chatId, png, "Mermaid diagram", signal).catch(() => {});
    }
  }
}

/** Local report/document files the agent previewed via `preview_file` since the
 *  baseline, so a finished HTML/Markdown report (or image) can be shared to the
 *  chat. PDFs hit the pane's not-renderable error and are skipped. */
function reportFilesFromAssistant(
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
  sinceCount: number,
): string[] {
  const chat = getChat(sessionId);
  if (!chat) return [];
  const assistants = chat.messages.filter((m) => m.role === "assistant");
  const relevant = assistants.slice(sinceCount);
  const paths: string[] = [];
  for (const m of relevant) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool-call" && p.type !== "tool") continue;
      if (!p.toolName?.includes("preview_file")) continue;
      const out = p.output as
        | { ok?: boolean; error?: string; path?: string }
        | undefined;
      if (out?.ok && out.path) paths.push(out.path);
    }
  }
  return [...new Set(paths)];
}

/** Best-effort: send report files (HTML/Markdown, images) the agent previewed. */
async function sendReportFiles(
  chatId: number | string,
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
  sinceCount: number,
  signal: AbortSignal,
): Promise<void> {
  const paths = reportFilesFromAssistant(getChat, sessionId, sinceCount);
  if (paths.length === 0) return;
  const { native } = await import("../ai/lib/native");
  const { readFile, readImageBase64, readFileBase64 } = native;
  const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
  for (const path of paths) {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      const img = await readImageBase64(path).catch(() => null);
      if (img) {
        const dataUrl = `data:${img.media_type};base64,${img.data}`;
        await sendPhoto(chatId, dataUrl, "Report image", signal).catch(
          () => {},
        );
      }
    } else {
      // Prefer the raw base64 reader so binary files (PDF) can be uploaded;
      // fall back to the text reader for a plain HTML/Markdown report.
      const bin = await readFileBase64(path).catch(() => null);
      if (bin) {
        const bytes = base64ToBytes(bin.data);
        const name = bin.file_name || path.split(/[\\/]/).pop() || "report";
        const caption =
          bin.media_type === "application/pdf" ? "Report (PDF)" : "Report";
        await sendDocument(chatId, bytes, name, caption, signal).catch(
          () => {},
        );
      } else {
        const r = await readFile(path).catch(() => null);
        if (r && r.kind === "text") {
          const bytes = new TextEncoder().encode(r.content);
          const name = path.split(/[\\/]/).pop() ?? "report.txt";
          await sendDocument(chatId, bytes, name, "Report", signal).catch(
            () => {},
          );
        }
      }
    }
  }
}

/**
 * Mirror the in-app conversation into Telegram in the other direction: a
 * message typed in Termigo (and the agent's reply once the run settles) shows
 * up in the bot's chat. Suppressed while the bot is relaying a Telegram run so
 * it doesn't echo messages it injected itself.
 */
async function runMirror(signal: AbortSignal): Promise<void> {
  let seenSession = "";
  while (!signal.aborted) {
    try {
      const store = await import("../ai/store/chatStore");
      const { enabled, chatId } = useTelegramStore.getState();
      const state = store.useChatStore.getState();
      if (enabled && chatId && state.activeSessionId) {
        const sessionId = state.activeSessionId;
        const chat = store.getChat(sessionId);
        const messages = chat?.messages ?? [];
        if (sessionId !== seenSession) {
          seenSession = sessionId;
          // Seed so pre-existing history is not replayed to Telegram - only
          // messages added from now on are mirrored.
          for (const m of messages) {
            markMessageSeen(m.id, sessionId, m.role, messageText(m));
          }
        }
        const settled =
          state.agentMeta.status === "idle" ||
          state.agentMeta.status === "error";
        for (const m of messages) {
          const text = messageText(m);
          if (isMessageSeen(m.id, sessionId, m.role, text)) continue;

          // Telegram-origin messages and streaming assistant text are handled
          // by the bot relay itself (dispatchAndStream); never mirror them.
          if (
            !text ||
            mirrorPauseCount > 0 ||
            (m.id && telegramOriginMessageIds.has(m.id)) ||
            (m.role === "user" && isTelegramOriginText(text))
          ) {
            markMessageSeen(m.id, sessionId, m.role, text);
            continue;
          }
          if (m.role === "assistant" && !settled) {
            // Still streaming; send once the run settles so the reply is whole.
            continue;
          }
          await sendReplyWithDiagrams(chatId, text, signal).catch(() => {});
          markMessageSeen(m.id, sessionId, m.role, text);
        }

        if (mirrorPauseCount === 0) {
          const chatStatus = chat?.status ?? "";
          const aqStore = await import("../ai/store/approvalQueueStore");
          const pending = sessionId
            ? getPendingApprovals(sessionId, store, aqStore.useApprovalQueue)
            : [];
          if (runBusy(chatStatus, state.agentMeta.status, pending.length > 0)) {
            await sendTyping(chatId, signal).catch(() => {});
          }
        }
      }
    } catch {
      // Mirroring is best-effort; never let it break the long-poll loop.
    }
    await sleep(signal, 2000);
  }
}

async function runAgentAndStream(
  action: () => Promise<boolean>,
  chatId: number,
  signal: AbortSignal,
  initialText?: string,
  _mode: "task" | "question" = "task",
): Promise<void> {
  try {
    const store = await import("../ai/store/chatStore");
    if (!store.useChatStore.getState().activeSessionId) {
      store.useChatStore.getState().newSession();
    }
    const sessionId = store.useChatStore.getState().activeSessionId;
    if (!sessionId) return;
    const baseline = countAssistantMessages(store.getChat, sessionId);

    // Snapshot existing message IDs prior to injecting this prompt.
    const priorChat = store.getChat(sessionId);
    const priorIds = new Set(
      (priorChat?.messages ?? []).map((m) => m.id).filter(Boolean) as string[],
    );

    // Pause the mirror before injecting the user message.
    pauseMirror();
    try {
      // Stream live progress and continuous typing alongside the run, superseding any prior stream.
      const progressCtl = new AbortController();
      progressCtrls.get(chatId)?.abort();
      progressCtrls.set(chatId, progressCtl);
      void publishProgress(
        chatId,
        sessionId,
        progressCtl.signal,
        initialText,
      ).catch(() => {});

      try {
        const accepted = await action();
        if (!accepted) {
          progressCtl.abort();
          await sendTelegram(
            chatId,
            "Could not start or resume the agent run - check the model / API key.",
            signal,
          );
          return;
        }

        // Immediately mark the freshly-injected user message as seen and Telegram-origin.
        const chatAfterSend = store.getChat(sessionId);
        for (const m of chatAfterSend?.messages ?? []) {
          if (m.id && !priorIds.has(m.id)) {
            markMessageSeen(m.id, sessionId, m.role, messageText(m));
            telegramOriginMessageIds.add(m.id);
          }
        }

        let currentBaseline = baseline;
        while (!signal.aborted) {
          const reply = await waitForReply(store, signal, sessionId, currentBaseline);
          await sendReplyWithDiagrams(chatId, reply, signal);

          // Immediately mark fresh assistant message(s) as seen and Telegram-origin.
          const chatAfterReply = store.getChat(sessionId);
          for (const m of chatAfterReply?.messages ?? []) {
            if (m.id && !priorIds.has(m.id)) {
              markMessageSeen(m.id, sessionId, m.role, messageText(m));
              telegramOriginMessageIds.add(m.id);
            }
          }

          currentBaseline = countAssistantMessages(store.getChat, sessionId);

          const queued = store.useChatStore.getState().steerQueue.pending.length > 0;
          const appStatus = store.useChatStore.getState().agentMeta.status;
          const chatStatus = store.getChat(sessionId)?.status ?? "";
          const aqStore = await import("../ai/store/approvalQueueStore");
          const pendingApprovals = getPendingApprovals(
            sessionId,
            store,
            aqStore.useApprovalQueue,
          );
          const busy = runBusy(chatStatus, appStatus, pendingApprovals.length > 0);

          if (!queued && !busy) break;

          if (!busy && queued) {
            const runtime = await import("../ai/store/chatRuntime");
            await runtime.flushSteer();
          }
        }

        // If run stopped due to step-cap, offer one-click continuation button
        const stopReason = store.useChatStore.getState().agentMeta.stopReason;
        if (stopReason === "step-cap") {
          const currentRound = store.useChatStore.getState().agentMeta.runRound;
          const { stepBudgetForRound } = await import("../ai/config");
          const nextBudget = stepBudgetForRound(currentRound + 1);
          await sendKeyboard(
            chatId,
            `Step limit reached. Continue to next round (${nextBudget} steps)?`,
            [[{ text: `>> Continue Step (${nextBudget} steps)`, callback_data: "resume:run" }]],
            signal,
          ).catch(() => {});
        } else if (stopReason) {
          await sendTelegram(
            chatId,
            `Agent paused (${stopReason}). Reply with /continue or your next instruction to proceed.`,
            signal,
          ).catch(() => {});
        }

        // Share any report/document file the agent previewed in this run.
        await sendReportFiles(
          chatId,
          store.getChat,
          sessionId,
          baseline,
          signal,
        );
      } finally {
        progressCtl.abort();
        if (progressCtrls.get(chatId) === progressCtl) {
          progressCtrls.delete(chatId);
        }
      }
    } finally {
      resumeMirror();
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

async function dispatchAndStream(
  text: string,
  chatId: number,
  signal: AbortSignal,
  initialText?: string,
  mode: "task" | "question" = "task",
): Promise<void> {
  const runtime = await import("../ai/store/chatRuntime");
  await runAgentAndStream(
    () => runtime.sendMessage(text),
    chatId,
    signal,
    initialText,
    mode,
  );
}

/**
 * Resume a paused/capped run, bumping to the next step budget tier (25 -> 50 -> 100).
 */
function startTelegramResume(chatId: number, signal: AbortSignal): void {
  pauseMirror();
  void (async () => {
    try {
      const store = await import("../ai/store/chatStore");
      const runtime = await import("../ai/store/chatRuntime");
      const { stepBudgetForRound } = await import("../ai/config");
      const sessionId = store.useChatStore.getState().activeSessionId;
      if (!sessionId) {
        await sendTelegram(
          chatId,
          "No active session to resume.",
          signal,
        );
        return;
      }
      const currentRound = store.useChatStore.getState().agentMeta.runRound;
      const nextBudget = stepBudgetForRound(currentRound + 1);
      await sendTelegram(
        chatId,
        `Continuing to next round (${nextBudget} steps)...`,
        signal,
      ).catch(() => {});
      await sendTyping(chatId, signal).catch(() => {});
      await runAgentAndStream(() => runtime.resumeRun(), chatId, signal);
    } catch (e) {
      if (!signal.aborted) {
        await sendTelegram(
          chatId,
          `Error during resume: ${e instanceof Error ? e.message : String(e)}`,
          signal,
        ).catch(() => {});
      }
    } finally {
      resumeMirror();
    }
  })();
}

/**
 * Dispatch a Telegram-initiated task with immediate synchronous mirror lock
 * and prompt tracking, preventing any race condition where the user's prompt
 * or resulting reply could be mirrored back to Telegram.
 *
 * If the agent is currently working on a task, the incoming message is handled
 * as a steer message: the user is notified that the agent is busy, and the
 * request is queued to run shortly after the current task finishes.
 */
async function startTelegramDispatch(
  text: string,
  chatId: number,
  signal: AbortSignal,
  ackText: string,
  mode: "task" | "question" = "task",
): Promise<void> {
  try {
    const store = await import("../ai/store/chatStore");
    const runtime = await import("../ai/store/chatRuntime");
    const sessionId = store.useChatStore.getState().activeSessionId;
    const appStatus = store.useChatStore.getState().agentMeta.status;
    const chatStatus = sessionId ? store.getChat(sessionId)?.status ?? "" : "";
    const busy = runBusy(chatStatus, appStatus);

    if (busy) {
      recordTelegramText(text);
      await sendTelegram(
        chatId,
        "The agent is busy. Your request will be processed shortly.",
        signal,
      ).catch(() => {});
      await runtime.sendMessage(text);
      return;
    }

    // Clean up previous finished progress message if any so it disappears on new task start
    const prevDoneMsgId = lastFinishedProgressMessageIds.get(chatId);
    if (prevDoneMsgId) {
      lastFinishedProgressMessageIds.delete(chatId);
      void deleteTelegramMessage(chatId, prevDoneMsgId);
    }

    pauseMirror();
    recordTelegramText(text);
    try {
      await sendTyping(chatId, signal).catch(() => {});
      await dispatchAndStream(text, chatId, signal, ackText, mode);
    } finally {
      resumeMirror();
    }
  } catch (e) {
    if (!signal.aborted) {
      await sendTelegram(
        chatId,
        `Error during run: ${e instanceof Error ? e.message : String(e)}`,
        signal,
      ).catch(() => {});
    }
  }
}

const HELP = [
  "/status - bot + agent status",
  "/pair - lock bot to this chat ID (only you can access)",
  "/unpair - unlock bot from this chat ID",
  "/query <question> - read-only question (or just type the question)",
  "/run <task> - run a task in the agent",
  "/continue - continue to next step (50/100 steps)",
  "/approve - approve all pending actions",
  "/deny - deny all pending actions",
  "/mode [all|edits|ask] - view or set autonomy approval mode",
  "/scope [list|add <host>|clear] - view or manage pentest scope",
  "/stop - stop the current run",
  "/new - start a new agent session",
  "/model - pick a model (opens a provider -> model menu)",
  "/model <id> - set the model directly",
  "/cost - today's & total spend",
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
  const owner = useTelegramStore.getState().chatId;
  if (owner && String(owner) !== String(chatId)) {
    await answerCallback(cb.id, "Unauthorized.", signal);
    return;
  }
  // Sensitive callbacks (tool approval, subagent approval, elicitation answer)
  // must come from the pairing *user*: a group chat shares one chatId with all
  // members, so the chat-level check above would let any member act as owner.
  const ownerUserId = useTelegramStore.getState().ownerUserId;
  if (
    ownerUserId &&
    (data.startsWith("ap:") ||
      data.startsWith("aq:") ||
      data.startsWith("el:")) &&
    (!cb.from || String(cb.from.id) !== String(ownerUserId))
  ) {
    await answerCallback(cb.id, "Unauthorized.", signal);
    return;
  }
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

  if (data.startsWith("ap:")) {
    const [, action, id] = data.split(":");
    const approved = action === "approve" || action === "session" || action === "always";
    const state = await import("../ai/store/chatStore");
    state.useChatStore.getState().respondToApproval(id, approved);
    // Allow session / allow always also record the tool so future calls skip the prompt.
    if (action === "session" || action === "always") {
      const aqStore = await import("../ai/store/approvalQueueStore");
      const tool = (await import("../ai/store/chatStore")).useChatStore
        .getState()
        .agentMeta.pendingApprovals?.find((p) => p.id === id)?.toolName;
      if (tool) {
        if (action === "session") {
          aqStore.rememberSessionAllowed(tool);
        } else {
          aqStore.rememberSessionAllowed(tool);
          const settingsStore = await import("../settings/store");
          const prefs = await import("../settings/preferences");
          const list = prefs.usePreferencesStore.getState().agentAlwaysAllowedTools;
          if (!list.includes(tool)) {
            settingsStore.setAgentAlwaysAllowedTools([...list, tool]);
          }
        }
      }
    }
    await answerCallback(
      cb.id,
      approved
        ? action === "session"
          ? "Allowed for this session."
          : action === "always"
            ? "Always allowed."
            : "Approved."
        : "Denied.",
      signal,
    );
    // Remove the approval card entirely (no "Action Approved via Telegram" text)
    await deleteTelegramMessage(chatId, messageId, signal);
    return;
  }

  if (data.startsWith("aq:")) {
    const [, action, id] = data.split(":");
    const aq = await import("../ai/store/approvalQueueStore");
    const approved = action === "approve" || action === "session" || action === "always";
    if (action === "session") {
      aq.useApprovalQueue.getState().respondWith([id], "allow-session");
    } else if (action === "always") {
      aq.useApprovalQueue.getState().respondWith([id], "allow-always");
    } else {
      aq.useApprovalQueue.getState().respond([id], approved);
    }
    await answerCallback(
      cb.id,
      action === "session"
        ? "Allowed for this session."
        : action === "always"
          ? "Always allowed."
          : approved
            ? "Approved."
            : "Denied.",
      signal,
    );
    // Remove the approval card entirely (no "Action Approved via Telegram" text)
    await deleteTelegramMessage(chatId, messageId, signal);
    return;
  }

  if (data.startsWith("el:")) {
    const [, id, idxStr] = data.split(":");
    const idx = parseInt(idxStr, 10);
    const el = await import("../ai/store/elicitationStore");
    const item = el.useElicitationStore
      .getState()
      .pending.find((p) => p.id === id);
    if (item?.options[idx]) {
      const choice = item.options[idx];
      el.useElicitationStore.getState().answer(id, choice);
      await answerCallback(cb.id, `Selected: ${choice}`, signal);
      await editKeyboard(chatId, messageId, `Selected: ${choice}`, [], signal);
      return;
    }
    await answerCallback(cb.id, "Question no longer pending.", signal);
    return;
  }

  if (data === "resume:run") {
    await answerCallback(cb.id, "Continuing to next round...", signal);
    if (messageId) {
      await editKeyboard(
        chatId,
        messageId,
        "Continuing to next round...",
        [],
        signal,
      ).catch(() => {});
    }
    startTelegramResume(chatId, signal);
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
    case "/pair": {
      const curOwner = useTelegramStore.getState().chatId;
      if (curOwner && String(curOwner) !== String(chatId)) {
        return;
      }
      useTelegramStore.getState().setChatId(String(chatId));
      if (msg.from?.id != null) {
        useTelegramStore.getState().setOwnerUserId(String(msg.from.id));
      }
      await sendTelegram(
        chatId,
        `Paired successfully. This bot is now locked to your chat ID (${chatId}). Messages from other chats will be ignored.`,
        signal,
      );
      return;
    }
    case "/unpair": {
      const curOwner = useTelegramStore.getState().chatId;
      if (curOwner && String(curOwner) !== String(chatId)) {
        return;
      }
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      useTelegramStore.getState().setChatId(null);
      useTelegramStore.getState().setOwnerUserId(null);
      await sendTelegram(
        chatId,
        "Bot has been unpaired. Any chat can now interact with this bot.",
        signal,
      );
      return;
    }
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
      startTelegramDispatch(
        tail,
        chatId,
        signal,
        "Question received, answering directly without progress.",
        "question",
      );
      return;
    }
    case "/run": {
      if (!tail)
        return void (await sendTelegram(chatId, "Usage: /run <task>", signal));
      startTelegramDispatch(
        tail,
        chatId,
        signal,
        "Task submitted - I'll post progress here.",
        "task",
      );
      return;
    }
    case "/continue":
    case "/resume":
    case "/next": {
      startTelegramResume(chatId, signal);
      return;
    }
    case "/stop": {
      const runtime = await import("../ai/store/chatRuntime");
      await runtime.stopRun();
      await sendTelegram(
        chatId,
        "Stop requested - the current run will settle.",
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
    case "/approve": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const state = await import("../ai/store/chatStore");
      const aq = await import("../ai/store/approvalQueueStore");
      const sessionId = state.useChatStore.getState().activeSessionId;
      const pending = sessionId
        ? getPendingApprovals(sessionId, state, aq.useApprovalQueue)
        : [];
      let count = 0;
      for (const p of pending) {
        state.useChatStore.getState().respondToApproval(p.id, true);
        aq.useApprovalQueue.getState().respond([p.id], true);
        count++;
      }
      await sendTelegram(
        chatId,
        `Approved ${count} pending action(s).`,
        signal,
      );
      return;
    }
    case "/deny": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const state = await import("../ai/store/chatStore");
      const aq = await import("../ai/store/approvalQueueStore");
      const sessionId = state.useChatStore.getState().activeSessionId;
      const pending = sessionId
        ? getPendingApprovals(sessionId, state, aq.useApprovalQueue)
        : [];
      let count = 0;
      for (const p of pending) {
        state.useChatStore.getState().respondToApproval(p.id, false);
        aq.useApprovalQueue.getState().respond([p.id], false);
        count++;
      }
      await sendTelegram(chatId, `Denied ${count} pending action(s).`, signal);
      return;
    }
    case "/mode": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const { usePreferencesStore } = await import(
        "@/modules/settings/preferences"
      );
      const { setAgentApprovalMode } = await import("@/modules/settings/store");
      const current = usePreferencesStore.getState().agentApprovalMode;
      if (!tail) {
        await sendTelegram(
          chatId,
          `Current approval mode: ${current}\n\nTo change: /mode all (autonomous), /mode edits (auto edits), /mode ask (always ask)`,
          signal,
        );
        return;
      }
      if (tail === "all" || tail === "auto") {
        await setAgentApprovalMode("all");
        await sendTelegram(
          chatId,
          "Approval mode set to: all (autonomous execution).",
          signal,
        );
        return;
      }
      if (tail === "edits") {
        await setAgentApprovalMode("edits");
        await sendTelegram(
          chatId,
          "Approval mode set to: edits (auto file edits).",
          signal,
        );
        return;
      }
      if (tail === "ask") {
        await setAgentApprovalMode("ask");
        await sendTelegram(
          chatId,
          "Approval mode set to: ask (prompt every time).",
          signal,
        );
        return;
      }
      await sendTelegram(
        chatId,
        "Unknown mode. Use: /mode all, /mode edits, or /mode ask",
        signal,
      );
      return;
    }
    case "/scope": {
      const ownerUserId = useTelegramStore.getState().ownerUserId;
      if (
        ownerUserId &&
        (!msg.from || String(msg.from.id) !== String(ownerUserId))
      ) {
        return;
      }
      const { usePreferencesStore } = await import(
        "@/modules/settings/preferences"
      );
      const { setPentestScope, setEnforcePentestScope } = await import(
        "@/modules/settings/store"
      );
      const prefs = usePreferencesStore.getState();
      const scope = prefs.pentestScope ?? [];
      const [sub, ...args] = tail.split(/\s+/);
      if (!tail || sub === "list") {
        const list =
          scope.length > 0 ? scope.map((h) => `- ${h}`).join("\n") : "(empty)";
        await sendTelegram(
          chatId,
          `Authorized Pentest Scope:\n${list}\nEnforced: ${prefs.enforcePentestScope ? "yes" : "no"}\n\nCommands: /scope add <ip-or-host>, /scope clear, /scope toggle`,
          signal,
        );
        return;
      }
      if (sub === "add") {
        const host = args.join(" ").trim();
        if (!host) {
          await sendTelegram(chatId, "Usage: /scope add <ip-or-host>", signal);
          return;
        }
        await setPentestScope([...new Set([...scope, host])]);
        await sendTelegram(
          chatId,
          `Added '${host}' to authorized pentest scope.`,
          signal,
        );
        return;
      }
      if (sub === "clear") {
        await setPentestScope([]);
        await sendTelegram(chatId, "Authorized pentest scope cleared.", signal);
        return;
      }
      if (sub === "toggle") {
        const next = !prefs.enforcePentestScope;
        await setEnforcePentestScope(next);
        await sendTelegram(
          chatId,
          `Pentest scope enforcement: ${next ? "enabled" : "disabled"}.`,
          signal,
        );
        return;
      }
      await sendTelegram(
        chatId,
        "Usage: /scope [list | add <host> | clear | toggle]",
        signal,
      );
      return;
    }
    default:
      // A bare message is a question/task - no /query prefix needed. Unknown
      // slash commands still get help so a typo isn't silently sent to the app.
      if (text.startsWith("/")) {
        await sendTelegram(chatId, HELP, signal);
        return;
      }
      startTelegramDispatch(
        text,
        chatId,
        signal,
        "Started working on your request.\nProgress updates will appear here.",
      );
      return;
  }
}

let currentUpdateOffset = 0;
let lastPollProgressTime = Date.now();
const POLLING_STALL_TIMEOUT_MS = 75_000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function checkPollingStall(): void {
  if (!useTelegramStore.getState().enabled || !loopController) return;
  const elapsed = Date.now() - lastPollProgressTime;
  if (elapsed > POLLING_STALL_TIMEOUT_MS) {
    console.warn(
      `[Telegram] Polling stall detected: no getUpdates progress for ${Math.round(
        elapsed / 1000,
      )}s. Reconnecting poller...`,
    );
    // Recycle controller so the hanging fetch terminates cleanly
    const oldCtrl = loopController;
    loopController = new AbortController();
    lastPollProgressTime = Date.now();
    oldCtrl.abort(new Error("Polling stall watchdog timeout"));
    void runLoop(loopController.signal);
  }
}

async function runLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted && useTelegramStore.getState().enabled) {
    try {
      const data = (await apiGet(
        `getUpdates?offset=${currentUpdateOffset}&timeout=30`,
        signal,
        45_000,
      )) as { ok: boolean; result: Update[] };
      lastPollProgressTime = Date.now();
      useTelegramStore.getState().setOnline(true);
      useTelegramStore.getState().setLastError(null);
      for (const u of data.result ?? []) {
        currentUpdateOffset = Math.max(currentUpdateOffset, u.update_id + 1);
        await handleUpdate(u, signal);
      }
    } catch (e) {
      if (signal.aborted) break;
      useTelegramStore.getState().setOnline(false);
      const errMsg = e instanceof Error ? e.message : String(e);
      useTelegramStore.getState().setLastError(errMsg);
      let backoffMs = 5000;
      if (e instanceof TelegramApiError && e.status === 429) {
        backoffMs = Math.max(1000, (e.retryAfter ?? 5) * 1000);
      }
      await sleep(signal, backoffMs);
    }
  }
  if (loopController?.signal === signal) {
    useTelegramStore.getState().setOnline(false);
  }
}

/** Start the long-polling loop (idempotent). */
export function startTelegramBot(): void {
  if (loopController) return;
  const controller = new AbortController();
  loopController = controller;
  const mirror = new AbortController();
  mirrorController = mirror;
  lastPollProgressTime = Date.now();
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(checkPollingStall, 15_000);
  useTelegramStore.getState().setOnline(true);
  useTelegramStore.getState().setLastError(null);
  void runLoop(controller.signal);
  void runMirror(mirror.signal);
}

/** Stop the long-polling loop. */
export function stopTelegramBot(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  loopController?.abort();
  loopController = null;
  mirrorController?.abort();
  mirrorController = null;
  useTelegramStore.getState().setOnline(false);
}

export const _testOnly = {
  seenMessageIds,
  seenFingerprints,
  telegramOriginMessageIds,
  recentTelegramPrompts,
  recordTelegramText,
  isTelegramOriginText,
  markMessageSeen,
  isMessageSeen,
  pauseMirror,
  resumeMirror,
  getMirrorPauseCount: () => mirrorPauseCount,
  splitTelegramText,
  clampTelegramText,
  runBusy,
  getPendingApprovals,
  startTelegramDispatch,
  sendTelegram,
  deleteTelegramMessage,
  lastFinishedProgressMessageIds,
  checkPollingStall,
  getLastPollProgressTime: () => lastPollProgressTime,
  setLastPollProgressTime: (t: number) => {
    lastPollProgressTime = t;
  },
  getCurrentUpdateOffset: () => currentUpdateOffset,
  setCurrentUpdateOffset: (offset: number) => {
    currentUpdateOffset = offset;
  },
  POLLING_STALL_TIMEOUT_MS,
  editProgressMessage,
  apiGet,
  apiPost,
  handleCallback,
  handleUpdate,
};
