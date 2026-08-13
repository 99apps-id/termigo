// OAuth account store: per-profile session cache and connection status.
//
// The full token set is persisted in the OS keyring by the Rust side; this
// store only mirrors the renderer-safe `OAuthSession` (access token + expiry)
// for the settings UI and for `buildLanguageModel`.

import { create } from "zustand";
import type { OAuthProfile, OAuthSession } from "./presets";
import { OAUTH_PROFILES } from "./presets";
import { oauthClear, oauthLoad } from "./bridge";

export type OAuthStatus =
  | "idle" // not connected
  | "connecting" // sign-in flow in progress
  | "awaiting-code" // manual-code flow: browser open, waiting for paste
  | "connected"
  | "error";

export type OAuthState = {
  tokens: Record<OAuthProfile, OAuthSession | null>;
  status: Record<OAuthProfile, OAuthStatus>;
  error: Record<OAuthProfile, string | null>;
  hydrate: () => Promise<void>;
  disconnect: (profile: OAuthProfile) => Promise<void>;
};

const EMPTY_TOKENS = (): Record<OAuthProfile, OAuthSession | null> =>
  Object.fromEntries(OAUTH_PROFILES.map((p) => [p, null])) as Record<
    OAuthProfile,
    OAuthSession | null
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

export const useOAuthStore = create<OAuthState>((set) => ({
  tokens: EMPTY_TOKENS(),
  status: EMPTY_STATUS(),
  error: EMPTY_ERROR(),

  hydrate: async () => {
    const entries = await Promise.all(
      OAUTH_PROFILES.map(async (p) => {
        const session = await oauthLoad(p).catch(() => null);
        return [p, session] as const;
      }),
    );
    const tokens = EMPTY_TOKENS();
    const status = EMPTY_STATUS();
    for (const [p, session] of entries) {
      tokens[p] = session;
      status[p] = session ? "connected" : "idle";
    }
    set({ tokens, status });
  },

  disconnect: async (profile) => {
    await oauthClear(profile).catch(() => {});
    set((s) => ({
      tokens: { ...s.tokens, [profile]: null },
      status: { ...s.status, [profile]: "idle" },
      error: { ...s.error, [profile]: null },
    }));
  },
}));
