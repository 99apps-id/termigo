// Durable storage for the Telegram `getUpdates` offset.
//
// The offset is how the relay confirms a batch to Telegram. Kept only in
// memory, every app restart began at offset 0 and Telegram redelivered the
// last unconfirmed batch, re-running whatever commands it held (a second
// `/run`, a second `/approve`).
//
// Keyed by the bot id, the numeric prefix of the token. Update ids are
// per-bot, so carrying one bot's offset onto a different token would SKIP that
// bot's pending updates instead of replaying them, which is the quieter and
// worse failure.

type OffsetStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const KEY_PREFIX = "termigo-telegram-offset:";

/**
 * The bot id from a token, which Telegram formats as `<bot_id>:<secret>`.
 *
 * Null for a missing or malformed token, so callers fall back to offset 0 and
 * replay the tail rather than trust an unknown stored value.
 */
export function botIdFromToken(
  token: string | null | undefined,
): string | null {
  if (!token) return null;
  const [id] = token.split(":");
  const trimmed = id?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : null;
}

export function offsetStorageKey(botId: string): string {
  return `${KEY_PREFIX}${botId}`;
}

/** A stored offset is only trusted when it is a non-negative integer. */
export function parseStoredOffset(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function resolveStorage(
  storage: OffsetStorage | null | undefined,
): OffsetStorage | null {
  // An explicit null means "no storage" (tests, headless); undefined means
  // "use the webview's localStorage".
  if (storage !== undefined) return storage;
  const native = (globalThis as { localStorage?: OffsetStorage }).localStorage;
  return native ?? null;
}

export function loadUpdateOffset(
  botId: string | null,
  storage?: OffsetStorage | null,
): number {
  if (!botId) return 0;
  const store = resolveStorage(storage);
  if (!store) return 0;
  try {
    return parseStoredOffset(store.getItem(offsetStorageKey(botId)));
  } catch {
    return 0;
  }
}

export function saveUpdateOffset(
  botId: string | null,
  offset: number,
  storage?: OffsetStorage | null,
): void {
  if (!botId || !Number.isInteger(offset) || offset < 0) return;
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(offsetStorageKey(botId), String(offset));
  } catch {
    // Best effort: a full or blocked storage must not break polling.
  }
}
