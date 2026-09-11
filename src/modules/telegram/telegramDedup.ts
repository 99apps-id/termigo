// Dedup + mirror-pause state for the Telegram bot relay.
//
// Extracted from bot.ts so the polling, progress, and dispatch layers can
// share one source of truth for:
// - Telegram-origin prompt tracking (prevents the bot from mirroring its own
//   injected messages back to the chat)
// - Seen-message tracking (prevents the Termigo -> Telegram mirror from
//   replaying history)
// - Mirror pause counter (serialises Telegram-initiated dispatches so the
//   mirror stays quiet while the bot posts its own answer)

const seenMessageIds = new Set<string>();
const seenFingerprints = new Set<string>();
const telegramOriginMessageIds = new Set<string>();
const recentTelegramPrompts = new Map<string, number>();
const TELEGRAM_ORIGIN_MAX = 500;

let mirrorPauseCount = 0;

export function recordTelegramText(text: string): void {
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

export function isTelegramOriginText(text: string): boolean {
  const norm = text.trim();
  if (!norm) return false;
  const ts = recentTelegramPrompts.get(norm);
  if (!ts) return false;
  if (Date.now() - ts < 10 * 60 * 1000) return true;
  recentTelegramPrompts.delete(norm);
  return false;
}

/** Stable key for the seen-message set. When a message carries no id the text
 *  stands in, but folded with its length so two distinct id-less messages that
 *  share their first 80 characters are not treated as one. */
function seenFingerprint(
  sessionId: string,
  role: string,
  id: string | undefined,
  text: string,
): string {
  return `${sessionId}:${role}:${id ?? `${text.length}:${text.slice(0, 80)}`}`;
}

export function markMessageSeen(
  id: string | undefined,
  sessionId: string,
  role: string,
  text: string,
): void {
  if (id) {
    seenMessageIds.add(id);
    while (seenMessageIds.size > 2000) {
      const iter = seenMessageIds.values();
      const first = iter.next();
      if (first.done) break;
      seenMessageIds.delete(first.value);
    }
  }
  const fp = seenFingerprint(sessionId, role, id, text);
  seenFingerprints.add(fp);
  while (seenFingerprints.size > 2000) {
    const iter = seenFingerprints.values();
    const first = iter.next();
    if (first.done) break;
    seenFingerprints.delete(first.value);
  }
}

export function isMessageSeen(
  id: string | undefined,
  sessionId: string,
  role: string,
  text: string,
): boolean {
  if (id && seenMessageIds.has(id)) return true;
  return seenFingerprints.has(seenFingerprint(sessionId, role, id, text));
}

export function pauseMirror(): void {
  mirrorPauseCount += 1;
}

export function resumeMirror(): void {
  mirrorPauseCount = Math.max(0, mirrorPauseCount - 1);
}

export function getMirrorPauseCount(): number {
  return mirrorPauseCount;
}

/** Record a message id as Telegram-origin, keeping the set bounded. Both the
 *  post-inject and post-reply marking passes must use this; the second pass
 *  used to add without trimming, so the cap was meaningless. */
export function rememberTelegramOrigin(id: string): void {
  telegramOriginMessageIds.add(id);
  while (telegramOriginMessageIds.size > TELEGRAM_ORIGIN_MAX) {
    const first = telegramOriginMessageIds.values().next();
    if (first.done) break;
    telegramOriginMessageIds.delete(first.value);
  }
}

// Exported for tests and internal consumers.
export {
  seenMessageIds,
  seenFingerprints,
  telegramOriginMessageIds,
  recentTelegramPrompts,
  TELEGRAM_ORIGIN_MAX,
};
