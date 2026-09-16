/**
 * When to reconnect a dropped SSH terminal, and how long to wait between
 * tries.
 *
 * Pure and import-free so the decision can be tested without a network: the
 * part that goes wrong here is not the socket, it is reconnecting when the
 * user meant to leave.
 */

/** Why a session ended, as far as the client can tell. */
export type ExitSignal = {
  code: number;
  /**
   * The remote reported an exit status before the channel ended.
   *
   * This is the whole distinction. A shell the user quit sends one; a
   * connection that dropped does not - and both otherwise arrive as code 0,
   * so without this a reconnect would fire every time someone typed `exit`.
   */
  clean: boolean;
};

/** Attempts after the first failure. Five tries span roughly half a minute. */
export const MAX_ATTEMPTS = 5;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 16_000;

/**
 * Whether a session that just ended should be reconnected.
 *
 * Deliberately conservative: anything that looks like the user leaving is left
 * alone. A wrong reconnect resurrects a shell someone deliberately closed,
 * which is worse than making them press a button.
 */
export function shouldReconnect(
  signal: ExitSignal,
  ctx: { closedByUser: boolean; attempts: number },
): boolean {
  if (ctx.closedByUser) return false;
  if (signal.clean) return false;
  return ctx.attempts < MAX_ATTEMPTS;
}

/**
 * Backoff for attempt `n` (1-based), doubling from a second and capped.
 *
 * Capped rather than unbounded because the common case is a laptop lid or a
 * tunnel blip: a minute of waiting is a minute of the user staring at a dead
 * terminal, and by then a manual reconnect is faster anyway.
 */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, attempt);
  return Math.min(BASE_DELAY_MS * 2 ** (n - 1), MAX_DELAY_MS);
}

/** What the terminal shows between attempts. Dim, and on its own line. */
export function reconnectNotice(attempt: number, delayMs: number): string {
  const secs = Math.round(delayMs / 1000);
  return `\r\n\x1b[2m[termigo] connection lost - reconnecting in ${secs}s (attempt ${attempt}/${MAX_ATTEMPTS})\x1b[0m\r\n`;
}

export function reconnectedNotice(): string {
  return `\r\n\x1b[2m[termigo] reconnected - this is a new shell, so your previous working directory and environment are gone\x1b[0m\r\n`;
}

export function gaveUpNotice(): string {
  return `\r\n\x1b[2m[termigo] could not reconnect after ${MAX_ATTEMPTS} attempts - reopen the tab to try again\x1b[0m\r\n`;
}
