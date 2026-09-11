// Media senders for Telegram bot: video, audio, animation, media group, sticker,
// voice, location, venue, contact, poll, dice. Uses FormData for uploads.

import { apiPost, apiPostForm, blobFromBytes } from "./api";

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
  await apiPost(
    "sendVenue",
    { chat_id: chatId, latitude, longitude, title, address },
    signal,
  );
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