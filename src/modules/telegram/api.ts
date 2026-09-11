// Telegram API helpers and media senders for the bot relay.

import { getTelegramToken } from "./keyring";
import { escapePlainTextToHtml, markdownToTelegramHtml } from "./progressFormat";

export const API = "https://api.telegram.org";

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

export function mergeSignals(
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

export async function parseTelegramError(res: Response): Promise<TelegramApiError> {
  let description = "";
  let retryAfter: number | undefined;
  try {
    const body = (await res.json()) as { description?: string; retry_after?: number };
    description = body.description ?? `${res.status} ${res.statusText}`;
    retryAfter = body.retry_after;
  } catch {
    description = `${res.status} ${res.statusText}`;
  }
  return new TelegramApiError(res.status, description, retryAfter);
}

export async function apiGet<T>(
  path: string,
  signal: AbortSignal,
  timeoutMs = 45_000,
): Promise<T> {
  const url = `${API}/bot${await getTelegramToken()}/${path}`;
  const { signal: merged, cleanup } = mergeSignals(signal, timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: merged });
    if (!res.ok) throw await parseTelegramError(res);
    return (await res.json()) as T;
  } finally {
    cleanup();
  }
}

export async function apiPost<T>(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const url = `${API}/bot${await getTelegramToken()}/${path}`;
  const { signal: merged, cleanup } = mergeSignals(signal, 45_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: merged,
    });
    if (!res.ok) throw await parseTelegramError(res);
    return (await res.json()) as T;
  } finally {
    cleanup();
  }
}

export async function apiPostForm<T>(
  path: string,
  form: FormData,
  signal: AbortSignal,
): Promise<T> {
  const url = `${API}/bot${await getTelegramToken()}/${path}`;
  const { signal: merged, cleanup } = mergeSignals(signal, 120_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: form,
      signal: merged,
    });
    if (!res.ok) throw await parseTelegramError(res);
    return (await res.json()) as T;
  } finally {
    cleanup();
  }
}

export function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

export function splitTelegramText(text: string, maxLen = 4000): string[] {
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

export async function sendTelegram(
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
      await apiPost(
        "sendMessage",
        { chat_id: chatId, text: escapePlainTextToHtml(chunk), parse_mode: "HTML" },
        signal,
      );
    }
  }
}

export async function sendProgressMessage(
  chatId: number | string,
  text: string,
  signal: AbortSignal,
): Promise<number | null> {
  const html = markdownToTelegramHtml(text);
  try {
    const res = (await apiPost<{ result: { message_id?: number } }>(
      "sendMessage",
      {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_notification: true,
      },
      signal,
    )) as { ok?: boolean; result?: { message_id?: number } };
    return res?.result?.message_id ?? null;
  } catch {
    try {
      const res = (await apiPost<{ result: { message_id?: number } }>(
        "sendMessage",
        {
          chat_id: chatId,
          text,
        },
        signal,
      )) as { ok?: boolean; result?: { message_id?: number } };
      return res?.result?.message_id ?? null;
    } catch {
      return null;
    }
  }
}

export async function editProgressMessage(
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
    )) as { ok?: boolean };
  };

  try {
    const res = await tryPost({ text: html, parse_mode: "HTML" });
    if (res?.ok) return true;
  } catch {
    // fall through to plain-text fallback
  }

  try {
    const res = await tryPost({ text: escapePlainTextToHtml(text) });
    return !!res?.ok;
  } catch {
    return false;
  }
}

export async function deleteTelegramMessage(
  chatId: number | string,
  messageId: number,
  signal: AbortSignal,
): Promise<void> {
  await apiPost("deleteMessage", { chat_id: chatId, message_id: messageId }, signal);
}

export async function sendTyping(
  chatId: number | string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost("sendChatAction", { chat_id: chatId, action: "typing" }, signal);
}

export function blobFromBytes(bytes: Uint8Array): Blob {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buf]);
}

export async function sendPhoto(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", blobFromBytes(bytes), filename);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendPhoto", form, signal);
}

export async function sendDocument(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", blobFromBytes(bytes), filename);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendDocument", form, signal);
}

/** Send video. */
export async function sendVideo(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("video", blobFromBytes(bytes), filename);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendVideo", form, signal);
}

/** Send audio. */
export async function sendAudio(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("audio", blobFromBytes(bytes), filename);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendAudio", form, signal);
}

/** Send animation (GIF/MP4 without sound). */
export async function sendAnimation(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("animation", blobFromBytes(bytes), filename);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendAnimation", form, signal);
}

/** Send a media group (album). */
export async function sendMediaGroup(
  chatId: number | string,
  items: Array<{
    type: "photo" | "video" | "audio" | "document";
    dataUrl?: string;
    bytes?: Uint8Array;
    filename?: string;
    caption?: string;
  }>,
  signal: AbortSignal,
): Promise<void> {
  const media: Array<Record<string, unknown>> = [];
  const form = new FormData();
  form.append("chat_id", String(chatId));
  for (const item of items) {
    const m: Record<string, unknown> = { type: item.type };
    if (item.caption) m.caption = item.caption.slice(0, 1024);
    if (item.dataUrl) {
      m.media = `attach://media_${media.length}`;
      const bin = atob(item.dataUrl.split(",")[1] ?? "");
      const buf = new ArrayBuffer(bin.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
      form.append(`media_${media.length}`, new Blob([view]), item.filename ?? "file");
    } else if (item.bytes && item.filename) {
      m.media = `attach://media_${media.length}`;
      form.append(`media_${media.length}`, blobFromBytes(item.bytes), item.filename);
    }
    media.push(m);
  }
  form.append("media", JSON.stringify(media));
  await apiPostForm("sendMediaGroup", form, signal);
}

/** Send a sticker. */
export async function sendSticker(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("sticker", blobFromBytes(bytes), filename);
  await apiPostForm("sendSticker", form, signal);
}

/** Send a voice note. */
export async function sendVoice(
  chatId: number | string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", blobFromBytes(bytes), filename);
  if (caption) form.append("caption", caption.slice(0, 1024));
  await apiPostForm("sendVoice", form, signal);
}

/** Send a location pin. */
export async function sendLocation(
  chatId: number | string,
  latitude: number,
  longitude: number,
  signal: AbortSignal,
): Promise<void> {
  await apiPost("sendLocation", { chat_id: chatId, latitude, longitude }, signal);
}

/** Send a venue. */
export async function sendVenue(
  chatId: number | string,
  latitude: number,
  longitude: number,
  title: string,
  address: string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost("sendVenue", { chat_id: chatId, latitude, longitude, title, address }, signal);
}

/** Send a contact. */
export async function sendContact(
  chatId: number | string,
  phoneNumber: string,
  firstName: string,
  lastName: string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost(
    "sendContact",
    { chat_id: chatId, phone_number: phoneNumber, first_name: firstName, last_name: lastName },
    signal,
  );
}

/** Send a poll. */
export async function sendPoll(
  chatId: number | string,
  question: string,
  options: string[],
  signal: AbortSignal,
  isAnonymous = true,
): Promise<void> {
  await apiPost(
    "sendPoll",
    { chat_id: chatId, question, options, is_anonymous: isAnonymous },
    signal,
  );
}

/** Send a dice. */
export async function sendDice(
  chatId: number | string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost("sendDice", { chat_id: chatId }, signal);
}

export async function sendKeyboard(
  chatId: number | string,
  text: string,
  rows: Array<Array<{ text: string; callback_data?: string }>>,
  signal: AbortSignal,
): Promise<void> {
  const replyMarkup: Record<string, unknown> = { inline_keyboard: rows };
  await apiPost("sendMessage", {
    chat_id: chatId,
    text: markdownToTelegramHtml(text),
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  }, signal);
}

export async function editKeyboard(
  chatId: number | string,
  messageId: number,
  text: string,
  rows: Array<Array<{ text: string; callback_data?: string }>>,
  signal: AbortSignal,
): Promise<void> {
  const replyMarkup: Record<string, unknown> = { inline_keyboard: rows };
  await apiPost("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: markdownToTelegramHtml(text),
    parse_mode: "HTML",
    reply_markup: rows.length ? replyMarkup : undefined,
  }, signal);
}

export async function answerCallback(
  callbackQueryId: string,
  text: string | null,
  signal: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) body.text = text.slice(0, 200);
  await apiPost("answerCallbackQuery", body, signal);
}

export async function modelLabel(modelId: string): Promise<string> {
  try {
    const { getModel } = await import("../ai/config");
    return getModel(modelId as any)?.label ?? modelId;
  } catch {
    return modelId;
  }
}

export async function buildStatus(): Promise<string> {
  const { useChatStore } = await import("../ai/store/chatStore");
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return "No active session.";
  const meta = state.agentMeta;
  const status = meta.status ?? "idle";
  const current = state.selectedModelId ? await modelLabel(state.selectedModelId) : "none";
  return [
    `Model: ${current}`,
    `Status: ${status}`,
    `Steps: ${meta.tokens.inputTokens + meta.tokens.outputTokens}`,
    `Tokens: ${meta.tokens.inputTokens + meta.tokens.outputTokens}`,
  ].join("\n");
}