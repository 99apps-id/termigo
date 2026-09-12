// Telegram Bot API HTTP client and low-level message senders.
//
// Extracted from bot.ts so the polling, command, and progress layers can
// share one token-aware fetch wrapper plus retry/rate-limit behaviour.

import { getTelegramToken } from "./keyring";
import {
  markdownToTelegramHtml,
  escapePlainTextToHtml,
} from "./progressFormat";

export type InlineButton = { text: string; callback_data: string };

export const API = "https://api.telegram.org";

/**
 * Hard limits the Bot API enforces. Exceeding any of them makes the whole
 * `sendMessage` fail with a 400, and for a model picker or an approval prompt
 * that means the user is left with no control at all - which reads as "the bot
 * is broken". Clamping beats failing.
 */
/** `text` on sendMessage / editMessageText. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
/** `callback_data`, counted in BYTES (spec), not UTF-16 code units. */
export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;
/** `inline_keyboard` total buttons. */
export const TELEGRAM_MAX_INLINE_BUTTONS = 100;
/** `text` of a single inline button. */
const TELEGRAM_MAX_BUTTON_TEXT_CHARS = 64;

/** UTF-8 byte length, because the callback_data limit is in bytes. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: 4 bytes for the pair, so skip the low surrogate.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Drop buttons Telegram would reject, and cap the total.
 *
 * A single over-long `callback_data` fails the entire message, taking every
 * other button with it. Filtering per button keeps the ones that fit (Approve
 * and Deny survive even when an extra "Allow always" does not), so a model
 * picker or an approval prompt degrades to fewer options instead of to none.
 * The message body always carries the text fallback (`/approve`, `/deny`,
 * `/model <id>`), so a dropped button is never a dead end.
 */
export function sanitizeInlineKeyboard(
  keyboard: readonly InlineButton[][],
): InlineButton[][] {
  const rows: InlineButton[][] = [];
  let total = 0;
  for (const row of keyboard) {
    const kept: InlineButton[] = [];
    for (const button of row) {
      if (total + kept.length >= TELEGRAM_MAX_INLINE_BUTTONS) break;
      if (
        !button.callback_data ||
        utf8Length(button.callback_data) > TELEGRAM_MAX_CALLBACK_DATA_BYTES
      ) {
        continue;
      }
      kept.push({
        text: clampText(button.text, TELEGRAM_MAX_BUTTON_TEXT_CHARS) || "•",
        callback_data: button.callback_data,
      });
    }
    if (kept.length > 0) rows.push(kept);
    total += kept.length;
  }
  return rows;
}

/** Trim to `max`, never returning an empty string for non-empty input. */
function clampText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1));
}

function clampMessage(text: string): string {
  return clampText(text, TELEGRAM_MAX_MESSAGE_CHARS);
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

export async function apiGet(
  path: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<unknown> {
  // The deadline is created BEFORE the token read, deliberately. The read is a
  // Tauri IPC call into the OS keychain; when it ran first, a slow keychain made
  // the whole request hang with no timeout to fail it, so the poll went silent
  // and the stall watchdog recycled it instead of reporting an error.
  const { signal: reqSignal, cleanup } = mergeSignals(signal, timeoutMs);
  try {
    const token = await getTelegramToken();
    if (!token) throw new Error("No Telegram token configured");
    const res = await fetch(`${API}/bot${token}/${path}`, {
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

export async function apiPost(
  path: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<unknown> {
  // Deadline first; see apiGet.
  const { signal: reqSignal, cleanup } = mergeSignals(signal, timeoutMs);
  try {
    const token = await getTelegramToken();
    if (!token) throw new Error("No Telegram token configured");
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

export async function apiPostForm(
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

export function sleep(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      // Remove the listener when the timer wins, or a long-lived signal
      // accumulates one per sleep (the 429 backoff path hit this).
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Split long messages on newline/word boundaries so nothing is truncated. */
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
        {
          chat_id: chatId,
          text: escapePlainTextToHtml(chunk),
          parse_mode: "HTML",
        },
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

export async function deleteTelegramMessage(
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
export async function sendTyping(
  chatId: number | string,
  signal: AbortSignal,
): Promise<void> {
  await apiPost(
    "sendChatAction",
    { chat_id: chatId, action: "typing" },
    signal,
  );
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(dataUrl.split(",")[1] ?? "");
}

/** Send a PNG (as a data URL) as a photo. Used for rasterised Mermaid. */
export async function sendPhoto(
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
export async function sendDocument(
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

/**
 * Send a message with an inline keyboard.
 *
 * Resolves `false` instead of rejecting on any failure. A picker or approval
 * prompt is part of a command handler's control flow, and an exception here
 * used to abort the whole handler - leaving the user with no reply, no picker
 * and no explanation. Callers check the result and fall back to text.
 */
export async function sendKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineButton[][],
  signal: AbortSignal,
): Promise<boolean> {
  const clean = sanitizeInlineKeyboard(keyboard);
  const body = clampMessage(text);
  const html = markdownToTelegramHtml(body);
  // An empty array is meaningful: it is how Telegram is told to REMOVE the
  // existing keyboard. Omitting reply_markup instead would leave the stale
  // buttons on screen.
  const markup = { inline_keyboard: clean };
  try {
    await apiPost(
      "sendMessage",
      {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        reply_markup: markup,
      },
      signal,
    );
    return true;
  } catch {
    try {
      await apiPost(
        "sendMessage",
        {
          chat_id: chatId,
          text: body,
          reply_markup: markup,
        },
        signal,
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Replace a message's text and keyboard. Resolves `false` on failure rather
 * than rejecting, for the same reason as `sendKeyboard`: a stale update that
 * throws down into the handler would drop the user's action silently.
 */
export async function editKeyboard(
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineButton[][],
  signal: AbortSignal,
): Promise<boolean> {
  const clean = sanitizeInlineKeyboard(keyboard);
  const body = clampMessage(text);
  const html = markdownToTelegramHtml(body);
  const markup = { inline_keyboard: clean };
  try {
    await apiPost(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        reply_markup: markup,
      },
      signal,
    );
    return true;
  } catch (err) {
    // "message is not modified" means the text is already correct.
    if (
      err instanceof TelegramApiError &&
      err.description.toLowerCase().includes("message is not modified")
    ) {
      return true;
    }
    try {
      await apiPost(
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text: body,
          reply_markup: markup,
        },
        signal,
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Acknowledge an inline-keyboard tap.
 *
 * Best-effort by design and never rejects: Telegram expires a callback query
 * after a short delay, so a user tapping a menu they left open for a minute
 * gets `400: query is too old`. That is normal, and it must not stop the
 * handler from setting the model or opening the picker.
 */
export async function answerCallback(
  callbackId: string,
  text: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await apiPost(
      "answerCallbackQuery",
      { callback_query_id: callbackId, text },
      signal,
    );
    return true;
  } catch {
    return false;
  }
}
