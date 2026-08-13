// OAuth bridge — thin invoke wrappers over the Rust oauth module plus the
// high-level sign-in flow (start -> browser/loopback/manual -> exchange).
// Token persistence AND renewal happen in Rust; this layer only ever sees the
// short-lived access token (`OAuthSession`), never the refresh token.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { OAuthProfile, OAuthSession } from "./presets";

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

/**
 * Exchange an authorization code for a session. The backend persists the full
 * token set in the OS keyring itself and returns only the renderer-safe view,
 * so the refresh token never crosses the IPC boundary.
 */
export async function oauthExchange(
  profile: OAuthProfile,
  state: string,
  code?: string,
): Promise<OAuthSession> {
  return invoke<OAuthSession>("oauth_exchange", {
    profile,
    stateValue: state,
    code: code ?? null,
  });
}

/** Read the stored session as-is, without renewing it (used to hydrate the UI). */
export async function oauthLoad(
  profile: OAuthProfile,
): Promise<OAuthSession | null> {
  return invoke<OAuthSession | null>("oauth_load", { profile });
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
export function isOAuthTokenStale(
  session: OAuthSession,
  leadMs = 60_000,
): boolean {
  if (!session.expires_at) return false;
  return Date.now() / 1000 >= session.expires_at - leadMs / 1000;
}

/**
 * Get a usable access token for a profile, renewing it first if it is close to
 * expiring.
 *
 * The load / refresh / re-store cycle lives in Rust (`oauth_session`). Doing it
 * here meant pulling the long-lived refresh token into the webview on every
 * check; the renderer only ever needs the short-lived access token.
 */
export async function ensureFreshOAuthToken(
  profile: OAuthProfile,
): Promise<OAuthSession | null> {
  return invoke<OAuthSession | null>("oauth_session", { profile });
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
