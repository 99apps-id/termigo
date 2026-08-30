// Telegram bot relay state. `enabled`/`chatId` persist; the token lives in the
// OS keychain (see keyring.ts), so it is never in localStorage.

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
      partialize: (s) => ({ enabled: s.enabled, chatId: s.chatId }),
    },
  ),
);
