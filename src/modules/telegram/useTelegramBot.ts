// Starts/stops the Telegram bot relay whenever the toggle or token changes.
//
// The bot runs in the main window, but the token and toggle are edited in the
// settings window, which shares the same localStorage. React to its writes so
// the loop starts/stops without reloading the app.

import { useEffect } from "react";
import { startTelegramBot, stopTelegramBot } from "./bot";
import { syncTelegramFromStorage, useTelegramStore } from "./store";
import { logRelayInfo } from "./telegramLog";

const STORAGE_KEY = "termigo-telegram";

/**
 * How many times a missing token is re-read before the relay is left off.
 *
 * Bounded on purpose: the native secret store can answer "nothing" before it has
 * loaded, and a single answer used to be final. Measured on a headless install
 * after a deploy: the app came up healthy, localStorage said `enabled: true`,
 * and the relay never started - no socket, no log line, until a restart.
 */
const TOKEN_RETRY_ATTEMPTS = 5;
const TOKEN_RETRY_DELAY_MS = 3_000;

export function useTelegramBot(): void {
  const enabled = useTelegramStore((s) => s.enabled);
  const hasToken = useTelegramStore((s) => s.hasToken);

  // Re-read BOTH sources on mount.
  //
  // The persisted toggle is restored from localStorage first, because a store
  // that hydrated empty would otherwise stay `enabled: false` while the saved
  // state still said enabled, and `refresh` only enables when the token is
  // present AND the session already looks enabled (or no saved state exists).
  // Then `refresh` reads the keychain, which is where the token actually lives.
  useEffect(() => {
    void syncTelegramFromStorage().then(() => useTelegramStore.getState().refresh());
  }, []);

  // A token read that missed at boot must not leave the relay off until the next
  // restart. Re-read a bounded number of times instead of trusting the first
  // answer, and stop as soon as a token appears (the effect above then starts
  // the relay through the usual path).
  useEffect(() => {
    if (!enabled || hasToken) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (cancelled) return;
      attempts += 1;
      void useTelegramStore
        .getState()
        .refresh()
        .then(() => {
          if (cancelled || useTelegramStore.getState().hasToken) return;
          if (attempts < TOKEN_RETRY_ATTEMPTS) {
            timer = setTimeout(attempt, TOKEN_RETRY_DELAY_MS);
          } else {
            logRelayInfo(
              "relay not started: no bot token in the keychain after retrying",
            );
          }
        });
    };
    timer = setTimeout(attempt, TOKEN_RETRY_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, hasToken]);

  // A settings-window change writes the same localStorage key, which fires a
  // storage event here; re-sync so the effect below reacts to the new toggle.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === STORAGE_KEY) void syncTelegramFromStorage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (enabled && hasToken) {
      void startTelegramBot();
      return () => stopTelegramBot();
    }
    // The one state worth naming: the toggle is on, so the UI says "enabled",
    // but there is no token and nothing is polling. Telegram's side stays
    // silent, so without this line "the bot is dead" has no cause attached.
    // Not logged for a plain disabled relay, which is the normal resting state
    // and would otherwise fire on every mount.
    if (enabled && !hasToken) {
      logRelayInfo("relay not started: enabled but no bot token in the keychain");
    }
    stopTelegramBot();
  }, [enabled, hasToken]);
}
