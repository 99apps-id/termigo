import { emitKeysChanged } from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { getProvider, KEYRING_SERVICE, type ProviderId } from "../config";

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

export async function cancelOAuthSignIn(): Promise<void> {
  await invoke("oauth_cancel");
}

/**
 * Hands the `code#state` pasted from the Claude consent page to the pending
 * sign-in. Used only when the loopback port is busy and the backend fell back
 * to the hosted pasted-code redirect.
 */
export async function submitOAuthCode(code: string): Promise<void> {
  await invoke("oauth_submit_code", { code });
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

async function clearOAuthTokens(provider: ProviderId): Promise<void> {
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

export async function signOutOAuth(provider: ProviderId): Promise<void> {
  await clearOAuthTokens(provider);
}

export async function getOAuthAccount(
  provider: ProviderId,
): Promise<OAuthAccount | null> {
  const t = await readOAuthTokens(provider);
  if (!t) return null;

  const nowSecs = Math.floor(Date.now() / 1000);
  if (t.expires_at > 0 && t.expires_at <= nowSecs) {
    if (!t.refresh_token || !(await refreshOAuthTokens(provider, t))) {
      if (!(await clearUnlessRotated(provider, t))) return null;
    }
    const refreshed = await readOAuthTokens(provider);
    if (!refreshed) return null;
    return {
      provider,
      email: refreshed.email ?? null,
      plan: refreshed.plan ?? null,
      accountId: refreshed.account_id ?? null,
    };
  }

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

// One refresh per PROVIDER, not per refresh token: a caller holding a token
// that a concurrent refresh already rotated must wait for, or reuse, that
// result instead of sending the spent token.
const activeRefreshes = new Map<ProviderId, Promise<OAuthTokens | null>>();

async function refreshOAuthTokens(
  provider: ProviderId,
  current: OAuthTokens,
): Promise<OAuthTokens | null> {
  const existing = activeRefreshes.get(provider);
  if (existing) return existing;

  const promise = (async () => {
    try {
      // Sub-agents refresh in parallel. One that read the keyring before a
      // sibling rotated R1 -> R2 would otherwise send the spent R1, fail, and
      // then clear the valid R2 the sibling just stored.
      const stored = await readOAuthTokens(provider);
      if (!stored) return null;
      if (
        (stored.refresh_token &&
          stored.refresh_token !== current.refresh_token) ||
        (stored.access_token !== current.access_token &&
          (stored.expires_at === 0 ||
            stored.expires_at > Math.floor(Date.now() / 1000)))
      ) {
        return stored;
      }
      const backendProvider =
        provider === "chatgpt" ? "openai-codex" : provider;
      const refreshed = await invoke<OAuthTokens>("oauth_refresh", {
        provider: backendProvider,
        refreshToken: current.refresh_token,
      });
      const merged: OAuthTokens = {
        ...refreshed,
        refresh_token: refreshed.refresh_token || current.refresh_token,
        account_id: refreshed.account_id ?? current.account_id,
        email: refreshed.email ?? current.email,
        plan: refreshed.plan ?? current.plan,
        id_token: refreshed.id_token || current.id_token,
      };
      await writeOAuthTokens(provider, merged);
      notifyChanged();
      return merged;
    } catch (e) {
      logRefreshFailure(provider, e);
      return null;
    } finally {
      activeRefreshes.delete(provider);
    }
  })();

  activeRefreshes.set(provider, promise);
  return promise;
}

/**
 * Clears the stored credential after a failed refresh, unless another caller
 * already rotated it: then the keyring holds a working pair, which is returned
 * instead of being deleted. Returns null once cleared.
 */
async function clearUnlessRotated(
  provider: ProviderId,
  failed: OAuthTokens,
): Promise<OAuthTokens | null> {
  const latest = await readOAuthTokens(provider);
  if (
    latest &&
    ((latest.refresh_token && latest.refresh_token !== failed.refresh_token) ||
      (latest.access_token !== failed.access_token &&
        (latest.expires_at === 0 ||
          latest.expires_at > Math.floor(Date.now() / 1000))))
  ) {
    return latest;
  }
  await clearOAuthTokens(provider);
  return null;
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
    if (t.expires_at <= nowSecs) {
      const latest = await clearUnlessRotated(provider, t);
      if (!latest) return null;
      return {
        accessToken: latest.access_token,
        accountId: latest.account_id ?? null,
      };
    }
  }

  return {
    accessToken: t.access_token,
    accountId: t.account_id ?? null,
  };
}

/**
 * Renew the credential on demand, ignoring the stored expiry. Muse tokens
 * carry `expires_at: 0` (a stable account key), so the expiry gate in
 * `getOAuthAccess` never renews them -- yet Meta can still retire a key, and
 * the only signal is the API rejecting it (401/404). The Muse fetch layer
 * calls this when that happens; for Muse the backend refresh is a remint
 * against the stored device credential. Returns null when there is nothing
 * to renew with or the renewal itself failed.
 */
export async function forceRefreshOAuthAccess(
  provider: ProviderId,
): Promise<OAuthAccess | null> {
  const t = await readOAuthTokens(provider);
  if (!t?.refresh_token) return null;
  const refreshed = await refreshOAuthTokens(provider, t);
  if (!refreshed) return null;
  return {
    accessToken: refreshed.access_token,
    accountId: refreshed.account_id ?? null,
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
