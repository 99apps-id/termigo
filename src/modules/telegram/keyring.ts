// Telegram bot token, stored in the OS keychain (never in a settings file).
//
// Cached in memory after the first successful read. This is not a micro
// optimisation: `secrets_get` is a Tauri IPC call into the OS keychain, and it
// sat on the hot path of the poll loop - every `getUpdates` (once per 30s) and
// every send went through it. On a headless box under a long agent run the read
// could take tens of seconds, and because the request's timeout was created
// AFTER this call, a slow read had no deadline at all: the poll simply went
// silent while the stall watchdog recycled it. Measured on the field install as
// `polling stalled: no getUpdates progress for 199s`, repeatedly.
//
// The token can only change through the three functions below, so a cache
// invalidated there cannot go stale.

import { invoke } from "@tauri-apps/api/core";

const SERVICE = "termigo-telegram";
const ACCOUNT = "token";

/** `undefined` = never read yet (or the last read found nothing). */
let cachedToken: string | null | undefined;
/** A read already on the wire, so several callers share one keychain round trip. */
let inFlightTokenRead: Promise<string | null> | null = null;

export async function getTelegramToken(): Promise<string | null> {
  // Only a token that was actually FOUND is cached.
  //
  // The exception path below was already guarded against caching a failure, but
  // the success path cached the absence too: a read that returned no value
  // before the native store had loaded pinned `null` for the process lifetime,
  // and nothing re-read it. Measured on a headless install after a deploy: the
  // app came up healthy, the relay never started, no Telegram socket opened, and
  // it stayed that way until a restart - the state even still said
  // `enabled: true`.
  //
  // Re-reading costs nothing when there is genuinely no token, because the relay
  // is not polling in that case. A real token is cached after the first hit, so
  // the hot path does not touch the keychain again.
  const found = cachedToken;
  if (found !== undefined && found !== null) return found;
  // Callers that arrive together (boot: the mount refresh and the first poll)
  // share ONE read rather than each spending a keychain round trip. This is what
  // the cache was added for originally, and dropping the negative cache must not
  // give that back.
  if (inFlightTokenRead) return inFlightTokenRead;

  const read = (async (): Promise<string | null> => {
    try {
      const v = await invoke<string | null>("secrets_get", {
        service: SERVICE,
        account: ACCOUNT,
      });
      const token = v && v.length > 0 ? v : null;
      cachedToken = token;
      return token;
    } catch {
      // Deliberately NOT cached: the keychain may not be available yet at
      // startup, and caching that failure would disable the bot until a restart.
      return null;
    }
  })();

  inFlightTokenRead = read;
  try {
    return await read;
  } finally {
    inFlightTokenRead = null;
  }
}

export async function getTelegramOwner(): Promise<string | null> {
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: SERVICE,
      account: "owner",
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setTelegramToken(token: string): Promise<void> {
  const t = token.trim();
  if (!t) throw new Error("Token is empty");
  await invoke("secrets_set", {
    service: SERVICE,
    account: ACCOUNT,
    password: t,
  });
  cachedToken = t;
}

export async function clearTelegramToken(): Promise<void> {
  try {
    await invoke("secrets_delete", { service: SERVICE, account: ACCOUNT });
  } catch {
    // ignore
  }
  cachedToken = null;
}

/** Drop the cache so the next read hits the keychain. For tests. */
export function resetTelegramTokenCache(): void {
  cachedToken = undefined;
}
