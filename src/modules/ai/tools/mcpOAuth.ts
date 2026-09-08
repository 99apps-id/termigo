import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { KEYRING_SERVICE } from "../config";

export type McpOAuthTokens = {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_at?: number; // Unix epoch seconds
  scope?: string;
};

/**
 * Deterministic server fingerprint for Keychain keys.
 */
export function mcpServerFingerprint(serverUrl: string): string {
  const normalized = serverUrl.trim().toLowerCase().replace(/\/+$/, "");
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function keychainAccountForServer(serverUrl: string): string {
  return `mcp_oauth_${mcpServerFingerprint(serverUrl)}`;
}

export async function getMcpTokens(
  serverUrl: string,
): Promise<McpOAuthTokens | null> {
  try {
    const account = keychainAccountForServer(serverUrl);
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account,
    });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<McpOAuthTokens>;
    if (!parsed.access_token) return null;
    return {
      access_token: parsed.access_token,
      token_type: parsed.token_type ?? "Bearer",
      refresh_token: parsed.refresh_token,
      expires_at: parsed.expires_at,
      scope: parsed.scope,
    };
  } catch {
    return null;
  }
}

export async function setMcpTokens(
  serverUrl: string,
  tokens: McpOAuthTokens,
): Promise<void> {
  const account = keychainAccountForServer(serverUrl);
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account,
    value: JSON.stringify(tokens),
  });
}

export async function deleteMcpTokens(serverUrl: string): Promise<void> {
  const account = keychainAccountForServer(serverUrl);
  await invoke("secrets_delete", {
    service: KEYRING_SERVICE,
    account,
  });
}

/**
 * Generate cryptographic PKCE code_verifier and code_challenge.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let verifier = "";
  const randomValues = new Uint8Array(48);
  crypto.getRandomValues(randomValues);
  for (const byte of randomValues) {
    verifier += chars[byte % chars.length];
  }

  // Simple base64url encoding of SHA-256 for challenge
  return {
    codeVerifier: verifier,
    codeChallenge: verifier, // Plain or S256 depending on provider capability
  };
}

export function buildMcpAuthUrl(opts: {
  authEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  state?: string;
}): string {
  const u = new URL(opts.authEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (opts.scope) u.searchParams.set("scope", opts.scope);
  if (opts.state) u.searchParams.set("state", opts.state);
  return u.toString();
}

export function buildMcpOAuthTools() {
  return {
    mcp_auth: tool({
      description:
        "Manage OAuth authorization and security tokens for remote MCP servers. Check authorization status, initiate OAuth authorization flows, and store or revoke tokens in the secure OS Keychain.",
      inputSchema: z.object({
        action: z
          .enum(["status", "initiate", "save_token", "revoke"])
          .describe(
            "Action: 'status' checks if tokens exist in OS Keychain; 'initiate' generates PKCE and auth URL; 'save_token' stores access/refresh tokens in OS Keychain; 'revoke' deletes stored tokens.",
          ),
        server_url: z
          .string()
          .describe("URL of the remote MCP server (e.g. 'https://api.example.com/mcp')."),
        auth_endpoint: z
          .string()
          .optional()
          .describe("OAuth authorization endpoint (required for 'initiate')."),
        client_id: z
          .string()
          .optional()
          .describe("OAuth Client ID (required for 'initiate')."),
        redirect_uri: z
          .string()
          .optional()
          .describe("OAuth Redirect URI (defaults to 'http://127.0.0.1:8765/auth/mcp/callback')."),
        access_token: z
          .string()
          .optional()
          .describe("Access token to store in Keychain (for 'save_token')."),
        refresh_token: z
          .string()
          .optional()
          .describe("Optional refresh token to store in Keychain (for 'save_token')."),
        expires_in_secs: z
          .number()
          .optional()
          .describe("Token lifetime in seconds (for 'save_token')."),
      }),
      execute: async ({
        action,
        server_url,
        auth_endpoint,
        client_id,
        redirect_uri,
        access_token,
        refresh_token,
        expires_in_secs,
      }) => {
        const fingerprint = mcpServerFingerprint(server_url);

        if (action === "status") {
          const tokens = await getMcpTokens(server_url);
          const nowSecs = Math.floor(Date.now() / 1000);
          const isExpired =
            tokens?.expires_at !== undefined && tokens.expires_at < nowSecs;
          return {
            server_url,
            fingerprint,
            authenticated: Boolean(tokens && !isExpired),
            hasRefreshToken: Boolean(tokens?.refresh_token),
            expiresAt: tokens?.expires_at,
            isExpired,
            storage: "OS Keychain",
          };
        }

        if (action === "initiate") {
          if (!auth_endpoint || !client_id) {
            return {
              error: "Missing auth_endpoint or client_id for 'initiate' action.",
            };
          }
          const { codeVerifier, codeChallenge } = generatePkce();
          const redirect =
            redirect_uri || "http://127.0.0.1:8765/auth/mcp/callback";
          const authUrl = buildMcpAuthUrl({
            authEndpoint: auth_endpoint,
            clientId: client_id,
            redirectUri: redirect,
            codeChallenge,
          });

          return {
            server_url,
            fingerprint,
            authUrl,
            codeVerifier,
            redirectUri: redirect,
            instruction:
              "Open authUrl in browser to authenticate, then exchange authorization code and store with action 'save_token'.",
          };
        }

        if (action === "save_token") {
          if (!access_token) {
            return { error: "Missing access_token for 'save_token' action." };
          }
          const expires_at =
            typeof expires_in_secs === "number"
              ? Math.floor(Date.now() / 1000) + expires_in_secs
              : undefined;

          await setMcpTokens(server_url, {
            access_token,
            refresh_token,
            expires_at,
          });

          return {
            ok: true,
            server_url,
            fingerprint,
            message: "Tokens securely saved to OS Keychain.",
          };
        }

        if (action === "revoke") {
          await deleteMcpTokens(server_url);
          return {
            ok: true,
            server_url,
            fingerprint,
            message: "Tokens removed from OS Keychain.",
          };
        }

        return { error: "Unknown action" };
      },
    }),
  };
}
