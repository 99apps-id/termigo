// Starts/stops the Telegram bot relay whenever the toggle or token changes.

import { useEffect } from "react";
import { startTelegramBot, stopTelegramBot } from "./bot";
import { useTelegramStore } from "./store";

export function useTelegramBot(): void {
  const enabled = useTelegramStore((s) => s.enabled);
  const hasToken = useTelegramStore((s) => s.hasToken);

  // Re-read hasToken on mount (the token lives in the keychain, not persist).
  useEffect(() => {
    void useTelegramStore.getState().refresh();
  }, []);

  useEffect(() => {
    if (enabled && hasToken) {
      startTelegramBot();
      return () => stopTelegramBot();
    }
    stopTelegramBot();
  }, [enabled, hasToken]);
}
