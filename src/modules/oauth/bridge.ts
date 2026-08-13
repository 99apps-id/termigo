// OAuth bridge — thin invoke wrappers over the Rust oauth module plus the
// high-level sign-in flow (start -> browser/loopback/manual -> exchange ->
// store). Token persistence happens in the OS keyring on the Rust side.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { OAuthProfile, OAuthTokens } from "./presets";

export type OAuthStartResult = {
  authorizeUrl: string;
  state: string;
  manualCode: boolean;
  redirectUri: string;
};

export type OAuthPollResult =
  | { kind: "pending" }
  | { kind: "ready"; code: string }
  | { kind: "expired" };

export async function oauthStart(
  profile: OAuthProfile,
): Promise<OAuthStartResult> {
  return invoke<OAuthStartResult>("oauth_start", { profile });
}

/**
 * Poll the Rust loopback listener. The Rust side serializes the result with
 * an internal `kind` tag (`{kind:"pending"}` / `{kind:"ready",code}` /
 * `{kind:"expired"}`), so the raw invoke value maps 1:1 onto the result.
 */
export async function oauthPoll(state: string): Promise<OAuthPollResult> {
  return invoke<OAuthPollResult>("oauth_poll", { stateValue: state });
}

export async function oauthExchange(
  profile: OAuthProfile,
  state: string,
  code?: string,
): Promise<OAuthTokens> {
  return invoke<OAuthTokens>("oauth_exchange", {
    profile,
    stateValue: state,
    code: code ?? null,
  });
}

export async function oauthRefresh(
  profile: OAuthProfile,
  refreshToken: string,
): Promise<OAuthTokens> {
  return invoke<OAuthTokens>("oauth_refresh", {
    profile,
    refreshToken,
  });
}

export async function oauthStore(
  profile: OAuthProfile,
  tokens: OAuthTokens,
): Promise<void> {
  await invoke("oauth_store", { profile, tokens });
}

export async function oauthLoad(
  profile: OAuthProfile,
): Promise<OAuthTokens | null> {
  return invoke<OAuthTokens | null>("oauth_load", { profile });
}

export async function oauthClear(profile: OAuthProfile): Promise<void> {
  await invoke("oauth_clear", { profile });
}

export async function oauthAntigravityProject(
  accessToken: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>("oauth_antigravity_project", {
      accessToken,
    });
  } catch {
    return null;
  }
}

/** True when the access token is expired or within `leadMs` of expiring. */
export function isOAuthTokenStale(tokens: OAuthTokens, leadMs = 60_000): boolean {
  if (!tokens.expires_at) return false;
  return Date.now() / 1000 >= tokens.expires_at - leadMs / 1000;
}

/**
 * Ensure a fresh access token for a profile. If the stored token is stale and
 * a refresh token exists, refresh it and persist the new tokens.
 */
export async function ensureFreshOAuthToken(
  profile: OAuthProfile,
): Promise<OAuthTokens | null> {
  const stored = await oauthLoad(profile);
  if (!stored) return null;
  if (!isOAuthTokenStale(stored)) return stored;
  if (!stored.refresh_token) return stored; // can't refresh; return as-is
  try {
    const fresh = await oauthRefresh(profile, stored.refresh_token);
    const merged: OAuthTokens = { ...stored, ...fresh };
    await oauthStore(profile, merged);
    return merged;
  } catch {
    return stored;
  }
}

/** Open the browser at the authorize URL. */
export async function openOAuthBrowser(url: string): Promise<void> {
  await openUrl(url);
}

/**
 * Pull an authorization code out of a pasted value. Claude's manual-code flow
 * can surface the code as a bare string, a full callback URL
 * (`https://console.anthropic.com/oauth/code/callback?code=…&state=…`), or a
 * `code#state` form — handle all of them.
 */
export function extractOAuthCode(pasted: string): string {
  const s = pasted.trim();
  if (!s) return "";
  const m = s.match(/[?&#]code=([^&#]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  const hash = s.match(/^([^#\s]+)#/);
  return hash ? hash[1] : s;
}
