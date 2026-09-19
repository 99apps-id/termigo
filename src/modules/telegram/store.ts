// Telegram bot relay state. `enabled`/`chatId` persist; the token lives in the
// OS keychain (see keyring.ts), so it is never in localStorage. `hasToken` is a
// cache of keychain presence persisted too, so a change made in the settings
// window (which writes the same localStorage) triggers the main window's
// storage listener and the bot restarts without a reload.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  getTelegramOwner,
  getTelegramToken,
  resetTelegramTokenCache,
} from "./keyring";

export type TelegramBotState = {
  enabled: boolean;
  online: boolean;
  hasToken: boolean;
  /**
   * Bumped every time the token is saved or removed (see `bumpTokenVersion`).
   * Persisted so a change made in the settings window reaches the main window
   * through the shared localStorage: the relay effect depends on the boolean
   * `hasToken` only, so a token *rotation* (`true -> true`) otherwise never
   * restarts the poller and the main window keeps polling with its stale
   * in-memory cached token - a second client on the same bot from Telegram's
   * point of view, i.e. a 409 factory.
   */
  tokenVersion: number;
  lastError: string | null;
  /** Optional owner chat id the bot only answers. */
  chatId: string | null;
  /** Optional owner *user* id, pinned at /pair. Checked on sensitive
   *  callbacks (approve/deny/elicitation) so a member of a paired group chat
   *  cannot take owner actions. */
  ownerUserId: string | null;
  setEnabled: (v: boolean) => void;
  setOnline: (v: boolean) => void;
  setLastError: (e: string | null) => void;
  setChatId: (id: string | null) => void;
  setOwnerUserId: (id: string | null) => void;
  setHasToken: (v: boolean) => void;
  /**
   * One-time pairing code shown in Settings. Whoever finds the bot username
   * could otherwise claim an unpaired bot with a bare `/pair`, so pairing
   * requires this code. Single-use: cleared on a successful pair.
   */
  pairingCode: string | null;
  /** Generate (if absent) and return the pairing code. */
  ensurePairingCode: () => string;
  /** Replace the pairing code with a fresh one. */
  regeneratePairingCode: () => string;
  /** Drop the pairing code (after a successful pair). */
  clearPairingCode: () => void;
  /** Signal a token save/remove so the relay restarts even when `hasToken` is unchanged. */
  bumpTokenVersion: () => void;
  /** Re-read hasToken from the keychain (called on app start / after token save). */
  refresh: () => Promise<void>;
};

export const useTelegramStore = create<TelegramBotState>()(
  persist(
    (set, get) => ({
      enabled: false,
      online: false,
      hasToken: false,
      tokenVersion: 0,
      lastError: null,
      chatId: null,
      ownerUserId: null,
      setEnabled: (v) => set({ enabled: v }),
      setOnline: (v) => set({ online: v }),
      setLastError: (e) => set({ lastError: e }),
      setChatId: (id) => set({ chatId: id }),
      setOwnerUserId: (id) => set({ ownerUserId: id }),
      setHasToken: (v) => set({ hasToken: v }),
      pairingCode: null,
      ensurePairingCode: () => {
        const cur = get().pairingCode;
        if (cur) return cur;
        return get().regeneratePairingCode();
      },
      regeneratePairingCode: () => {
        const bytes = new Uint32Array(1);
        crypto.getRandomValues(bytes);
        const code = String(bytes[0] % 1_000_000).padStart(6, "0");
        set({ pairingCode: code });
        return code;
      },
      clearPairingCode: () => {
        if (get().pairingCode !== null) set({ pairingCode: null });
      },
      bumpTokenVersion: () =>
        set((s) => ({ tokenVersion: (s.tokenVersion ?? 0) + 1 })),
      refresh: async () => {
        const token = await getTelegramToken();
        const owner = await getTelegramOwner();
        const hasToken = !!token;
        const cur = get();
        const raw =
          typeof localStorage !== "undefined"
            ? localStorage.getItem("termigo-telegram")
            : null;
        const shouldEnable = hasToken && (cur.enabled || !raw || !!owner);
        set({
          hasToken,
          ...(shouldEnable ? { enabled: true } : {}),
          ...(owner && !cur.chatId ? { chatId: owner } : {}),
          ...(owner && !cur.ownerUserId ? { ownerUserId: owner } : {}),
        });
      },
    }),
    {
      name: "termigo-telegram",
      partialize: (s) => ({
        enabled: s.enabled,
        chatId: s.chatId,
        ownerUserId: s.ownerUserId,
        hasToken: s.hasToken,
        tokenVersion: s.tokenVersion,
        pairingCode: s.pairingCode,
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
        if (typeof state.ownerUserId === "string" && state.ownerUserId !== cur.ownerUserId)
          useTelegramStore.getState().setOwnerUserId(state.ownerUserId);
        if (state.ownerUserId === null && cur.ownerUserId !== null)
          useTelegramStore.getState().setOwnerUserId(null);
        if (typeof state.online === "boolean" && state.online !== cur.online)
          useTelegramStore.getState().setOnline(state.online);
        if (
          typeof state.lastError === "string" &&
          state.lastError !== cur.lastError
        )
          useTelegramStore.getState().setLastError(state.lastError);
        if (state.lastError === null && cur.lastError !== null)
          useTelegramStore.getState().setLastError(null);
        if (
          typeof state.tokenVersion === "number" &&
          state.tokenVersion !== cur.tokenVersion
        )
          useTelegramStore.setState({ tokenVersion: state.tokenVersion });
        // The pairing code is generated in Settings but verified in the main
        // window; propagate it the same way so both sides agree.
        if (
          typeof state.pairingCode === "string" &&
          state.pairingCode !== cur.pairingCode
        )
          useTelegramStore.setState({ pairingCode: state.pairingCode });
        if (state.pairingCode === null && cur.pairingCode !== null)
          useTelegramStore.setState({ pairingCode: null });
      }
    }
  } catch {
    // ignore malformed storage
  }
  // The keychain is the source of truth for the token. Drop this window's
  // in-memory cache first: after a rotation the settings window already caches
  // the new token while this window still holds the old one, and polling with
  // a stale token is a second client on the same bot (Telegram 409).
  resetTelegramTokenCache();
  await useTelegramStore.getState().refresh();
}
