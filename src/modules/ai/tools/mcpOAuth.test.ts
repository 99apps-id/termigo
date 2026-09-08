import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpAuthUrl,
  buildMcpOAuthTools,
  deleteMcpTokens,
  generatePkce,
  getMcpTokens,
  mcpServerFingerprint,
  setMcpTokens,
} from "./mcpOAuth";

const mockKeychain = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "secrets_get") {
      const key = `${args.service}:${args.account}`;
      return mockKeychain.get(key) ?? null;
    }
    if (cmd === "secrets_set") {
      const key = `${args.service}:${args.account}`;
      mockKeychain.set(key, String(args.value));
      return;
    }
    if (cmd === "secrets_delete") {
      const key = `${args.service}:${args.account}`;
      mockKeychain.delete(key);
      return;
    }
    return null;
  }),
}));

describe("mcpOAuth", () => {
  beforeEach(() => {
    mockKeychain.clear();
  });

  it("computes deterministic server fingerprint", () => {
    const fp1 = mcpServerFingerprint("https://api.github.com/mcp");
    const fp2 = mcpServerFingerprint("https://api.github.com/mcp/");
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBeGreaterThan(0);
  });

  it("stores, retrieves, and deletes tokens in OS Keychain mock", async () => {
    const url = "https://mcp.linear.app/sse";
    const tokens = {
      access_token: "secret_access_token_123",
      refresh_token: "refresh_token_456",
      expires_at: 1999999999,
    };

    await setMcpTokens(url, tokens);
    const retrieved = await getMcpTokens(url);
    expect(retrieved?.access_token).toBe("secret_access_token_123");
    expect(retrieved?.refresh_token).toBe("refresh_token_456");

    await deleteMcpTokens(url);
    const afterDelete = await getMcpTokens(url);
    expect(afterDelete).toBeNull();
  });

  it("generates PKCE and builds authorization URL", () => {
    const pkce = generatePkce();
    expect(pkce.codeVerifier.length).toBeGreaterThan(10);
    expect(pkce.codeChallenge.length).toBeGreaterThan(10);

    const authUrl = buildMcpAuthUrl({
      authEndpoint: "https://auth.example.com/oauth/authorize",
      clientId: "client-id-123",
      redirectUri: "http://127.0.0.1:8765/auth/mcp/callback",
      codeChallenge: pkce.codeChallenge,
    });
    expect(authUrl).toContain("response_type=code");
    expect(authUrl).toContain("client_id=client-id-123");
    expect(authUrl).toContain("code_challenge=");
  });

  it("executes mcp_auth tool commands properly", async () => {
    const tools = buildMcpOAuthTools();
    const execute = tools.mcp_auth.execute;
    if (!execute) throw new Error("execute not found");

    // 1. Check status (initially unauthenticated)
    const status1 = (await execute(
      {
        action: "status",
        server_url: "https://remote.mcp.io",
      },
      { toolCallId: "c1", messages: [] } as never,
    )) as { authenticated: boolean };
    expect(status1.authenticated).toBe(false);

    // 2. Save token
    const saveRes = (await execute(
      {
        action: "save_token",
        server_url: "https://remote.mcp.io",
        access_token: "tok_abc",
        expires_in_secs: 3600,
      },
      { toolCallId: "c2", messages: [] } as never,
    )) as { ok: boolean };
    expect(saveRes.ok).toBe(true);

    // 3. Status now authenticated
    const status2 = (await execute(
      {
        action: "status",
        server_url: "https://remote.mcp.io",
      },
      { toolCallId: "c3", messages: [] } as never,
    )) as { authenticated: boolean };
    expect(status2.authenticated).toBe(true);

    // 4. Revoke
    const revokeRes = (await execute(
      {
        action: "revoke",
        server_url: "https://remote.mcp.io",
      },
      { toolCallId: "c4", messages: [] } as never,
    )) as { ok: boolean };
    expect(revokeRes.ok).toBe(true);
  });
});
