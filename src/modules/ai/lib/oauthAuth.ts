import { emitKeysChanged } from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import {
  getProvider,
  KEYRING_SERVICE,
  type ProviderId,
} from "../config";

export type OAuthTokens = {
  provider: string;
  access_token: string;
  refresh_token: string;
  id_token?: string | null;
  /** Unix SECONDS, absolute. */
  expires_at: number;
  account_id?: string | null;
  email?: string | null;
  plan?: string | null;
};

export type OAuthAccess = {
  accessToken: string;
  accountId: string | null;
};

export type OAuthAccount = {
  provider: ProviderId;
  email: string | null;
  plan: string | null;
  accountId: string | null;
};

const REFRESH_SKEW_SECONDS = 300;

function keyringAccountFor(provider: ProviderId): string {
  return getProvider(provider).keyringAccount;
}

export async function readOAuthTokens(
  provider: ProviderId,
): Promise<OAuthTokens | null> {
  try {
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: keyringAccountFor(provider),
    });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OAuthTokens>;
    if (!parsed.access_token) return null;
    return {
      provider: parsed.provider ?? provider,
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token ?? "",
      id_token: parsed.id_token ?? null,
      expires_at: parsed.expires_at ?? 0,
      account_id: parsed.account_id ?? null,
      email: parsed.email ?? null,
      plan: parsed.plan ?? null,
    };
  } catch {
    return null;
  }
}

export async function writeOAuthTokens(
  provider: ProviderId,
  tokens: OAuthTokens,
): Promise<void> {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: keyringAccountFor(provider),
    password: JSON.stringify(tokens),
  });
}

export async function signInWithOAuth(
  provider: ProviderId,
): Promise<OAuthAccount> {
  const backendProvider = provider === "chatgpt" ? "openai-codex" : provider;
  const tokens = await invoke<OAuthTokens>("oauth_login", {
    provider: backendProvider,
  });
  await writeOAuthTokens(provider, tokens);
  notifyChanged();
  return {
    provider,
    email: tokens.email ?? null,
    plan: tokens.plan ?? null,
    accountId: tokens.account_id ?? null,
  };
}

export async function signOutOAuth(provider: ProviderId): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: keyringAccountFor(provider),
    });
  } catch {
    // Already gone.
  }
  notifyChanged();
}

export async function getOAuthAccount(
  provider: ProviderId,
): Promise<OAuthAccount | null> {
  const t = await readOAuthTokens(provider);
  if (!t) return null;
  return {
    provider,
    email: t.email ?? null,
    plan: t.plan ?? null,
    accountId: t.account_id ?? null,
  };
}

export async function isOAuthSignedIn(provider: ProviderId): Promise<boolean> {
  return (await readOAuthTokens(provider)) !== null;
}

const activeRefreshes = new Map<string, Promise<OAuthTokens | null>>();

async function refreshOAuthTokens(
  provider: ProviderId,
  current: OAuthTokens,
): Promise<OAuthTokens | null> {
  const key = `${provider}:${current.refresh_token}`;
  const existing = activeRefreshes.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const backendProvider = provider === "chatgpt" ? "openai-codex" : provider;
      const refreshed = await invoke<OAuthTokens>("oauth_refresh", {
        provider: backendProvider,
        refreshToken: current.refresh_token,
      });
      await writeOAuthTokens(provider, refreshed);
      notifyChanged();
      return refreshed;
    } catch (e) {
      logRefreshFailure(provider, e);
      return null;
    } finally {
      activeRefreshes.delete(key);
    }
  })();

  activeRefreshes.set(key, promise);
  return promise;
}

function logRefreshFailure(provider: ProviderId, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn(`[oauthAuth:${provider}] refresh failed: ${msg}`);
}

export async function getOAuthAccess(
  provider: ProviderId,
): Promise<OAuthAccess | null> {
  const t = await readOAuthTokens(provider);
  if (!t) return null;

  const nowSecs = Math.floor(Date.now() / 1000);
  const isExpiring =
    t.expires_at > 0 && t.expires_at - nowSecs < REFRESH_SKEW_SECONDS;

  if (isExpiring && t.refresh_token) {
    const refreshed = await refreshOAuthTokens(provider, t);
    if (refreshed) {
      return {
        accessToken: refreshed.access_token,
        accountId: refreshed.account_id ?? null,
      };
    }
    if (t.expires_at <= nowSecs) return null;
  }

  return {
    accessToken: t.access_token,
    accountId: t.account_id ?? null,
  };
}

const AUTH_CHANGED_EVENT = "termigo-oauth-auth-changed";

function notifyChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
  }
  emitKeysChanged();
}

export function onOAuthAuthChanged(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AUTH_CHANGED_EVENT, cb);
  return () => window.removeEventListener(AUTH_CHANGED_EVENT, cb);
}
