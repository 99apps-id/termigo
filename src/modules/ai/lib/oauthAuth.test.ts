import { beforeEach, describe, expect, it, vi } from "vitest";

type Stored = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

const keyring = new Map<string, string>();
// A snapshot handed to the next secrets_get, modelling a caller that read the
// keyring before a sibling's refresh wrote the rotated pair.
const staleReads: string[] = [];
const validRefresh = new Set<string>();
let issued = 0;
const calls: string[] = [];

vi.mock("@/modules/settings/store", () => ({ emitKeysChanged: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, string>) => {
    calls.push(cmd);
    switch (cmd) {
      case "secrets_get": {
        const stale = staleReads.shift();
        return stale ?? keyring.get(args.account) ?? null;
      }
      case "secrets_set":
        keyring.set(args.account, args.password);
        return null;
      case "secrets_delete":
        keyring.delete(args.account);
        return null;
      case "oauth_refresh": {
        // Refresh tokens are single use, as on the real endpoint.
        if (!validRefresh.delete(args.refreshToken)) {
          throw new Error("invalid_grant");
        }
        issued += 1;
        await Promise.resolve();
        validRefresh.add(`R${issued + 1}`);
        return {
          provider: "claude-oauth",
          access_token: `A${issued + 1}`,
          refresh_token: `R${issued + 1}`,
          expires_at: nowSecs() + 3600,
        };
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }),
}));

const { forceRefreshOAuthAccess, getOAuthAccess } = await import("./oauthAuth");
const { renewClaudeAccess } = await import("./claudeOAuth");

const ACCOUNT = "claude-oauth-token";
const nowSecs = () => Math.floor(Date.now() / 1000);
const store = (t: Stored) =>
  keyring.set(ACCOUNT, JSON.stringify({ provider: "claude-oauth", ...t }));
const stored = () => JSON.parse(keyring.get(ACCOUNT) ?? "null") as Stored;
const refreshCalls = () => calls.filter((c) => c === "oauth_refresh").length;

describe("oauthAuth refresh", () => {
  beforeEach(() => {
    keyring.clear();
    staleReads.length = 0;
    validRefresh.clear();
    calls.length = 0;
    issued = 0;
    validRefresh.add("R1");
  });

  it("runs one refresh for parallel callers holding the same expired token", async () => {
    store({ access_token: "A1", refresh_token: "R1", expires_at: 1 });
    const results = await Promise.all([
      getOAuthAccess("claude-oauth"),
      getOAuthAccess("claude-oauth"),
      getOAuthAccess("claude-oauth"),
      getOAuthAccess("claude-oauth"),
    ]);
    expect(results.map((r) => r?.accessToken)).toEqual([
      "A2",
      "A2",
      "A2",
      "A2",
    ]);
    expect(refreshCalls()).toBe(1);
    expect(stored().refresh_token).toBe("R2");
  });

  it("a caller with a token a sibling already rotated keeps the new pair", async () => {
    const spent = JSON.stringify({
      provider: "claude-oauth",
      access_token: "A1",
      refresh_token: "R1",
      expires_at: 1,
    });
    keyring.set(ACCOUNT, spent);
    expect((await getOAuthAccess("claude-oauth"))?.accessToken).toBe("A2");

    staleReads.push(spent);
    const late = await getOAuthAccess("claude-oauth");

    expect(late?.accessToken).toBe("A2");
    expect(refreshCalls()).toBe(1);
    expect(calls).not.toContain("secrets_delete");
    expect(stored().refresh_token).toBe("R2");
  });

  it("still clears a credential whose own refresh token was rejected", async () => {
    validRefresh.clear();
    store({ access_token: "A1", refresh_token: "R1", expires_at: 1 });
    expect(await getOAuthAccess("claude-oauth")).toBeNull();
    expect(keyring.has(ACCOUNT)).toBe(false);
  });

  it("reuses a newer access token even when the refresh token did not rotate", async () => {
    const stale = JSON.stringify({
      provider: "claude-oauth",
      access_token: "old-access",
      refresh_token: "same-refresh",
      expires_at: 1,
    });
    keyring.set(
      ACCOUNT,
      JSON.stringify({
        provider: "claude-oauth",
        access_token: "new-access",
        refresh_token: "same-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    staleReads.push(stale);
    expect((await getOAuthAccess("claude-oauth"))?.accessToken).toBe(
      "new-access",
    );
    expect(calls).not.toContain("oauth_refresh");
    expect(calls).not.toContain("secrets_delete");
  });

  it("forced renewal ignores a far-off expiry", async () => {
    store({
      access_token: "A1",
      refresh_token: "R1",
      expires_at: nowSecs() + 3600,
    });
    expect((await forceRefreshOAuthAccess("claude-oauth"))?.accessToken).toBe(
      "A2",
    );
  });
});

describe("renewClaudeAccess (401 path)", () => {
  beforeEach(() => {
    keyring.clear();
    staleReads.length = 0;
    validRefresh.clear();
    calls.length = 0;
    issued = 0;
    validRefresh.add("R1");
  });

  it("forces a refresh when the stored token is the one just rejected", async () => {
    store({
      access_token: "A1",
      refresh_token: "R1",
      expires_at: nowSecs() + 3600,
    });
    expect(await renewClaudeAccess("A1")).toBe("A2");
    expect(refreshCalls()).toBe(1);
  });

  it("reuses a token a parallel request already renewed", async () => {
    store({
      access_token: "A9",
      refresh_token: "R9",
      expires_at: nowSecs() + 3600,
    });
    expect(await renewClaudeAccess("A1")).toBe("A9");
    expect(refreshCalls()).toBe(0);
  });
});
