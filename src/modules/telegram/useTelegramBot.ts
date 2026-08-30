// Starts/stops the Telegram bot relay whenever the toggle or token changes.
//
// The bot runs in the main window, but the token and toggle are edited in the
// settings window, which shares the same localStorage. React to its writes so
// the loop starts/stops without reloading the app.

import { useEffect } from "react";
import { startTelegramBot, stopTelegramBot } from "./bot";
import { syncTelegramFromStorage, useTelegramStore } from "./store";

const STORAGE_KEY = "termigo-telegram";

export function useTelegramBot(): void {
  const enabled = useTelegramStore((s) => s.enabled);
  const hasToken = useTelegramStore((s) => s.hasToken);

  // Re-read hasToken on mount (the token lives in the keychain, not persist).
  useEffect(() => {
    void useTelegramStore.getState().refresh();
  }, []);

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
      startTelegramBot();
      return () => stopTelegramBot();
    }
    stopTelegramBot();
  }, [enabled, hasToken]);
}
