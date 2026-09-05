// Telegram bot relay - drives Termigo's in-app agent via the normal chat
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
    id?: string;
    role: string;
    parts?: Array<{
      type?: string;
      text?: string;
      toolName?: string;
      output?: unknown;
    }>;
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

async function sendTelegram(
  chatId: number | string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost("sendMessage", { chat_id: chatId, text }, signal);
}

/**
 * Show the "typing…" bubble in the Telegram chat. The bubble lasts ~5s, so a
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
): Promise<unknown> {
  const token = await getTelegramToken();
  if (!token) throw new Error("No Telegram token configured");
  const res = await fetch(`${API}/bot${token}/${path}`, {
    method: "POST",
    body: form,
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
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
  let everBusy = false;
  while (!signal.aborted && Date.now() - started < MAX_WAIT) {
    const appStatus = store.useChatStore.getState().agentMeta.status;
    const chatStatus = store.getChat(sessionId)?.status ?? "";
    const busy = runBusy(chatStatus, appStatus);
    if (busy) everBusy = true;
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
    } else {
      const err = store.useChatStore.getState().agentMeta.error;
      if (err) {
        return `Run ended with an error: ${err}`;
      }
      if (everBusy && !busy && !queued) {
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
  // Telegram's typing bubble lasts ~5s; re-send it on an interval so the chat
  // keeps showing "typing…" for the whole run, not just at the first tick.
  let lastTypingAt = 0;
  const sentApprovalIds = new Set<string>();
  const sentElicitationIds = new Set<string>();
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

    // Keep the "typing…" bubble alive while the run is busy (thinking,
    // streaming, or awaiting approval).
    const busy =
      status === "thinking" ||
      status === "streaming" ||
      status === "awaiting-approval";
    if (busy && now - lastTypingAt >= 4000) {
      lastTypingAt = now;
      await sendTyping(chatId, signal).catch(() => {});
    }

    if (status !== lastStatus) {
      lastStatus = status;
      const line = statusLabel(status);
      if (line && status !== "awaiting-approval") {
        await sendTelegram(chatId, line, signal).catch(() => {});
        lastSentAt = now;
      }
    }

    // Surface pending tool approvals as interactive inline buttons in Telegram
    const pendingApprovals = meta.pendingApprovals ?? [];
    for (const p of pendingApprovals) {
      if (!sentApprovalIds.has(p.id)) {
        sentApprovalIds.add(p.id);
        const keyboard: InlineButton[][] = [
          [
            { text: "Approve", callback_data: `ap:approve:${p.id}` },
            { text: "Deny", callback_data: `ap:deny:${p.id}` },
          ],
        ];
        await sendKeyboard(
          chatId,
          `Action Approval Required:\nTool: ${p.toolName}\nTarget: ${p.summary}`,
          keyboard,
          signal,
        ).catch(() => {});
        lastSentAt = now;
      }
    }

    // Surface approval queue requests (subagents / gated tools)
    const aqStore = await import("../ai/store/approvalQueueStore");
    const aqPending = aqStore.useApprovalQueue.getState().pending;
    for (const q of aqPending) {
      if (!sentApprovalIds.has(q.id)) {
        sentApprovalIds.add(q.id);
        const keyboard: InlineButton[][] = [
          [
            { text: "Approve", callback_data: `aq:approve:${q.id}` },
            { text: "Deny", callback_data: `aq:deny:${q.id}` },
          ],
        ];
        await sendKeyboard(
          chatId,
          `Approval Required (${q.requester}):\nTool: ${q.toolName}\nTarget: ${q.summary}`,
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
        const keyboard: InlineButton[][] = el.options.slice(0, 6).map((opt, i) => [
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

/** Telegram caps a message at 4096 chars; clamp so a long reply is not dropped. */
function clampTelegramText(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
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
  await sendTelegram(chatId, clampTelegramText(text), signal);
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
      }
    } catch {
      // Mirroring is best-effort; never let it break the long-poll loop.
    }
    await sleep(signal, 2000);
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

    // Snapshot existing message IDs prior to injecting this prompt.
    const priorChat = store.getChat(sessionId);
    const priorIds = new Set(
      (priorChat?.messages ?? []).map((m) => m.id).filter(Boolean) as string[],
    );

    // Pause the mirror before injecting the user message.
    pauseMirror();
    try {
      const accepted = await runtime.sendMessage(text);
      if (!accepted) {
        await sendTelegram(
          chatId,
          "Could not start the agent run - check the model / API key.",
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

      // Stream live progress alongside the run, superseding any prior stream.
      const progressCtl = new AbortController();
      progressCtrls.get(chatId)?.abort();
      progressCtrls.set(chatId, progressCtl);
      void publishProgress(chatId, sessionId, progressCtl.signal).catch(
        () => {},
      );
      try {
        const reply = await waitForReply(store, signal, sessionId, baseline);
        await sendReplyWithDiagrams(chatId, reply, signal);

        // Immediately mark fresh assistant message(s) as seen and Telegram-origin.
        const chatAfterReply = store.getChat(sessionId);
        for (const m of chatAfterReply?.messages ?? []) {
          if (m.id && !priorIds.has(m.id)) {
            markMessageSeen(m.id, sessionId, m.role, messageText(m));
            telegramOriginMessageIds.add(m.id);
          }
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

/**
 * Dispatch a Telegram-initiated task with immediate synchronous mirror lock
 * and prompt tracking, preventing any race condition where the user's prompt
 * or resulting reply could be mirrored back to Telegram.
 */
function startTelegramDispatch(
  text: string,
  chatId: number,
  signal: AbortSignal,
  ackText: string,
): void {
  pauseMirror();
  recordTelegramText(text);
  void (async () => {
    try {
      await sendTelegram(chatId, ackText, signal).catch(() => {});
      await dispatchAndStream(text, chatId, signal);
    } catch (e) {
      if (!signal.aborted) {
        await sendTelegram(
          chatId,
          `Error during run: ${e instanceof Error ? e.message : String(e)}`,
          signal,
        ).catch(() => {});
      }
    } finally {
      resumeMirror();
    }
  })();
}

const HELP = [
  "/status - bot + agent status",
  "/query <question> - read-only question (or just type the question)",
  "/run <task> - run a task in the agent",
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
    const approved = action === "approve";
    const state = await import("../ai/store/chatStore");
    state.useChatStore.getState().respondToApproval(id, approved);
    await answerCallback(cb.id, approved ? "Approved." : "Denied.", signal);
    await editKeyboard(
      chatId,
      messageId,
      `Action ${approved ? "Approved" : "Denied"} via Telegram.`,
      [],
      signal,
    );
    return;
  }

  if (data.startsWith("aq:")) {
    const [, action, id] = data.split(":");
    const approved = action === "approve";
    const aq = await import("../ai/store/approvalQueueStore");
    aq.useApprovalQueue.getState().respond([id], approved);
    await answerCallback(cb.id, approved ? "Approved." : "Denied.", signal);
    await editKeyboard(
      chatId,
      messageId,
      `Action ${approved ? "Approved" : "Denied"} via Telegram.`,
      [],
      signal,
    );
    return;
  }

  if (data.startsWith("el:")) {
    const [, id, idxStr] = data.split(":");
    const idx = parseInt(idxStr, 10);
    const el = await import("../ai/store/elicitationStore");
    const item = el.useElicitationStore.getState().pending.find((p) => p.id === id);
    if (item && item.options[idx]) {
      const choice = item.options[idx];
      el.useElicitationStore.getState().answer(id, choice);
      await answerCallback(cb.id, `Selected: ${choice}`, signal);
      await editKeyboard(chatId, messageId, `Selected: ${choice}`, [], signal);
      return;
    }
    await answerCallback(cb.id, "Question no longer pending.", signal);
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
      startTelegramDispatch(
        tail,
        chatId,
        signal,
        "Started - I'll post progress here.",
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
      );
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
      const state = await import("../ai/store/chatStore");
      const aq = await import("../ai/store/approvalQueueStore");
      const pending = state.useChatStore.getState().agentMeta.pendingApprovals ?? [];
      const aqPending = aq.useApprovalQueue.getState().pending;
      let count = 0;
      for (const p of pending) {
        state.useChatStore.getState().respondToApproval(p.id, true);
        count++;
      }
      for (const q of aqPending) {
        aq.useApprovalQueue.getState().respond([q.id], true);
        count++;
      }
      await sendTelegram(chatId, `Approved ${count} pending action(s).`, signal);
      return;
    }
    case "/deny": {
      const state = await import("../ai/store/chatStore");
      const aq = await import("../ai/store/approvalQueueStore");
      const pending = state.useChatStore.getState().agentMeta.pendingApprovals ?? [];
      const aqPending = aq.useApprovalQueue.getState().pending;
      let count = 0;
      for (const p of pending) {
        state.useChatStore.getState().respondToApproval(p.id, false);
        count++;
      }
      for (const q of aqPending) {
        aq.useApprovalQueue.getState().respond([q.id], false);
        count++;
      }
      await sendTelegram(chatId, `Denied ${count} pending action(s).`, signal);
      return;
    }
    case "/mode": {
      const { usePreferencesStore } = await import("@/modules/settings/preferences");
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
        await sendTelegram(chatId, "Approval mode set to: all (autonomous execution).", signal);
        return;
      }
      if (tail === "edits") {
        await setAgentApprovalMode("edits");
        await sendTelegram(chatId, "Approval mode set to: edits (auto file edits).", signal);
        return;
      }
      if (tail === "ask") {
        await setAgentApprovalMode("ask");
        await sendTelegram(chatId, "Approval mode set to: ask (prompt every time).", signal);
        return;
      }
      await sendTelegram(chatId, "Unknown mode. Use: /mode all, /mode edits, or /mode ask", signal);
      return;
    }
    case "/scope": {
      const { usePreferencesStore } = await import("@/modules/settings/preferences");
      const { setPentestScope, setEnforcePentestScope } = await import("@/modules/settings/store");
      const prefs = usePreferencesStore.getState();
      const scope = prefs.pentestScope ?? [];
      const [sub, ...args] = tail.split(/\s+/);
      if (!tail || sub === "list") {
        const list = scope.length > 0 ? scope.map((h) => `- ${h}`).join("\n") : "(empty)";
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
        await sendTelegram(chatId, `Added '${host}' to authorized pentest scope.`, signal);
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
        await sendTelegram(chatId, `Pentest scope enforcement: ${next ? "enabled" : "disabled"}.`, signal);
        return;
      }
      await sendTelegram(chatId, "Usage: /scope [list | add <host> | clear | toggle]", signal);
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
        "Started - working on it; progress will show here.",
      );
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
  const mirror = new AbortController();
  mirrorController = mirror;
  useTelegramStore.getState().setOnline(true);
  useTelegramStore.getState().setLastError(null);
  void runLoop(controller.signal);
  void runMirror(mirror.signal);
}

/** Stop the long-polling loop. */
export function stopTelegramBot(): void {
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
};
