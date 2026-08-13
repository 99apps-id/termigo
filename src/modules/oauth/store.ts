// OAuth account store — per-profile token cache + connection status.
// Tokens are persisted in the OS keyring via the Rust `oauth_store` command;
// this store is the in-memory mirror used by the settings UI and by
// `buildLanguageModel` (via `getOAuthTokens`).

import { create } from "zustand";
import type { OAuthProfile, OAuthTokens } from "./presets";
import { OAUTH_PROFILES } from "./presets";
import {
  oauthClear,
  oauthExchange,
  oauthLoad,
  oauthStore,
  type OAuthStartResult,
} from "./bridge";

export type OAuthStatus =
  | "idle" // not connected
  | "connecting" // sign-in flow in progress
  | "awaiting-code" // manual-code flow: browser open, waiting for paste
  | "connected"
  | "error";

export type OAuthState = {
  tokens: Record<OAuthProfile, OAuthTokens | null>;
  status: Record<OAuthProfile, OAuthStatus>;
  error: Record<OAuthProfile, string | null>;
  /** The in-flight sign-in (start result) per profile. */
  pendingStart: Record<OAuthProfile, OAuthStartResult | null>;
  hydrate: () => Promise<void>;
  /** Complete a manual-code flow (Claude): paste code -> exchange -> store. */
  completeManual: (
    profile: OAuthProfile,
    code: string,
  ) => Promise<boolean>;
  disconnect: (profile: OAuthProfile) => Promise<void>;
};

const EMPTY_TOKENS = (): Record<OAuthProfile, OAuthTokens | null> =>
  Object.fromEntries(OAUTH_PROFILES.map((p) => [p, null])) as Record<
    OAuthProfile,
    OAuthTokens | null
  >;

const EMPTY_STATUS = (): Record<OAuthProfile, OAuthStatus> =>
  Object.fromEntries(OAUTH_PROFILES.map((p) => [p, "idle"])) as Record<
    OAuthProfile,
    OAuthStatus
  >;

const EMPTY_ERROR = (): Record<OAuthProfile, string | null> =>
  Object.fromEntries(OAUTH_PROFILES.map((p) => [p, null])) as Record<
    OAuthProfile,
    string | null
  >;

const EMPTY_PENDING = (): Record<OAuthProfile, OAuthStartResult | null> =>
  Object.fromEntries(OAUTH_PROFILES.map((p) => [p, null])) as Record<
    OAuthProfile,
    OAuthStartResult | null
  >;

export const useOAuthStore = create<OAuthState>((set, get) => ({
  tokens: EMPTY_TOKENS(),
  status: EMPTY_STATUS(),
  error: EMPTY_ERROR(),
  pendingStart: EMPTY_PENDING(),

  hydrate: async () => {
    const entries = await Promise.all(
      OAUTH_PROFILES.map(async (p) => {
        const tokens = await oauthLoad(p).catch(() => null);
        return [p, tokens] as const;
      }),
    );
    const tokens = EMPTY_TOKENS();
    const status = EMPTY_STATUS();
    for (const [p, t] of entries) {
      tokens[p] = t;
      status[p] = t ? "connected" : "idle";
    }
    set({ tokens, status });
  },

  completeManual: async (profile, code) => {
    const start = get().pendingStart[profile];
    if (!start) return false;
    try {
      const tokens = await oauthExchange(profile, start.state, code.trim());
      await oauthStore(profile, tokens);
      set((s) => ({
        tokens: { ...s.tokens, [profile]: tokens },
        status: { ...s.status, [profile]: "connected" },
        error: { ...s.error, [profile]: null },
        pendingStart: { ...s.pendingStart, [profile]: null },
      }));
      return true;
    } catch (e) {
      set((s) => ({
        status: { ...s.status, [profile]: "error" },
        error: { ...s.error, [profile]: String(e) },
      }));
      return false;
    }
  },

  disconnect: async (profile) => {
    await oauthClear(profile).catch(() => {});
    set((s) => ({
      tokens: { ...s.tokens, [profile]: null },
      status: { ...s.status, [profile]: "idle" },
      error: { ...s.error, [profile]: null },
      pendingStart: { ...s.pendingStart, [profile]: null },
    }));
  },
}));
