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

/** `undefined` = never read yet, `null` = read and absent. */
let cachedToken: string | null | undefined;

export async function getTelegramToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: SERVICE,
      account: ACCOUNT,
    });
    cachedToken = v && v.length > 0 ? v : null;
    return cachedToken;
  } catch {
    // Deliberately NOT cached: the keychain may not be available yet at
    // startup, and caching that failure would disable the bot until a restart.
    return null;
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
