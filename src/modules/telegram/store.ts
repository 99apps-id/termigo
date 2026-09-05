// Telegram bot relay state. `enabled`/`chatId` persist; the token lives in the
// OS keychain (see keyring.ts), so it is never in localStorage. `hasToken` is a
// cache of keychain presence persisted too, so a change made in the settings
// window (which writes the same localStorage) triggers the main window's
// storage listener and the bot restarts without a reload.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getTelegramToken } from "./keyring";

export type TelegramBotState = {
  enabled: boolean;
  online: boolean;
  hasToken: boolean;
  lastError: string | null;
  /** Optional owner chat id the bot only answers. */
  chatId: string | null;
  setEnabled: (v: boolean) => void;
  setOnline: (v: boolean) => void;
  setLastError: (e: string | null) => void;
  setChatId: (id: string | null) => void;
  setHasToken: (v: boolean) => void;
  /** Re-read hasToken from the keychain (called on app start / after token save). */
  refresh: () => Promise<void>;
};

export const useTelegramStore = create<TelegramBotState>()(
  persist(
    (set) => ({
      enabled: false,
      online: false,
      hasToken: false,
      lastError: null,
      chatId: null,
      setEnabled: (v) => set({ enabled: v }),
      setOnline: (v) => set({ online: v }),
      setLastError: (e) => set({ lastError: e }),
      setChatId: (id) => set({ chatId: id }),
      setHasToken: (v) => set({ hasToken: v }),
      refresh: async () => {
        const token = await getTelegramToken();
        set({ hasToken: !!token });
      },
    }),
    {
      name: "termigo-telegram",
      partialize: (s) => ({
        enabled: s.enabled,
        chatId: s.chatId,
        hasToken: s.hasToken,
        online: s.online,
        lastError: s.lastError,
      }),
    },
  ),
);

/**
 * Re-read the persisted fields into this window's store and refresh hasToken
 * from the keychain. The bot runs in the main window but is configured in the
 * settings window; both share the same localStorage, so a change in one fires a
 * `storage` event in the other. Both windows call this from their listener -
 * and both guards skip no-op writes so windows do not ping-pong each other.
 */
export async function syncTelegramFromStorage(): Promise<void> {
  try {
    const raw = localStorage.getItem("termigo-telegram");
    if (raw) {
      const state = (
        JSON.parse(raw) as {
          state?: Partial<TelegramBotState>;
        }
      ).state;
      if (state) {
        const cur = useTelegramStore.getState();
        if (typeof state.enabled === "boolean" && state.enabled !== cur.enabled)
          useTelegramStore.getState().setEnabled(state.enabled);
        if (typeof state.chatId === "string" && state.chatId !== cur.chatId)
          useTelegramStore.getState().setChatId(state.chatId);
        if (state.chatId === null && cur.chatId !== null)
          useTelegramStore.getState().setChatId(null);
        if (typeof state.online === "boolean" && state.online !== cur.online)
          useTelegramStore.getState().setOnline(state.online);
        if (
          typeof state.lastError === "string" &&
          state.lastError !== cur.lastError
        )
          useTelegramStore.getState().setLastError(state.lastError);
        if (state.lastError === null && cur.lastError !== null)
          useTelegramStore.getState().setLastError(null);
      }
    }
  } catch {
    // ignore malformed storage
  }
  // The keychain is the source of truth for the token.
  await useTelegramStore.getState().refresh();
}
