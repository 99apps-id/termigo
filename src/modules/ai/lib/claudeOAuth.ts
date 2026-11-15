import { getOAuthAccess } from "./oauthAuth";

export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_OAUTH_DEFAULT_CLI_VERSION = "2.1.325";

export const CLAUDE_OAUTH_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,thinking-token-count-2026-05-13,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";

export const CLAUDE_PDF_BETA = "pdfs-2024-09-25";

let learnedClaudeCliVersion: string | null = null;

export function getClaudeCliVersion(): string {
  return learnedClaudeCliVersion ?? CLAUDE_OAUTH_DEFAULT_CLI_VERSION;
}

export function setClaudeCliVersionForTests(version: string | null): void {
  learnedClaudeCliVersion = version;
}

export function claudeCliUserAgent(version = getClaudeCliVersion()): string {
  return `claude-cli/${version} (external, sdk-cli)`;
}

export function extractClaudeCodeMinVersion(body: string): string | null {
  if (!body.includes("claude_code_version_too_old")) return null;
  const match =
    body.match(/minimum(?:\s+required)?\s+version(?:\s+is)?\s+v?(\d+\.\d+\.\d+)/i) ??
    body.match(/at least\s+v?(\d+\.\d+\.\d+)/i) ??
    body.match(/v?(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export type AnthropicSystemBlock = {
  type: string;
  text?: string;
  cache_control?: unknown;
  [key: string]: unknown;
};

/**
 * Guarantees block 0 is the exact Claude Code identity without cache_control,
 * and removes duplicate copies of it from subsequent blocks (matching odon-ai
 * and termixgo). Anthropic rejects OAuth subscription requests when another
 * block precedes it.
 */
export function withClaudeCodeIdentity(system: unknown): AnthropicSystemBlock[] {
  const identityBlock: AnthropicSystemBlock = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY,
  };
  const rest: AnthropicSystemBlock[] = [];
  if (typeof system === "string") {
    const trimmed = system.trim();
    if (trimmed && trimmed !== CLAUDE_CODE_IDENTITY) {
      rest.push({ type: "text", text: system });
    }
  } else if (Array.isArray(system)) {
    for (const item of system) {
      if (!item || typeof item !== "object") continue;
      const block = item as AnthropicSystemBlock;
      if (block.type === "text" && block.text?.trim() === CLAUDE_CODE_IDENTITY) {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) {
        continue;
      }
      rest.push(block);
    }
  }
  return [identityBlock, ...rest];
}

export function hasPdfDocumentInMessages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: unknown; source?: { media_type?: unknown } };
      if (p.type === "document" && p.source?.media_type === "application/pdf") {
        return true;
      }
    }
  }
  return false;
}

export function buildClaudeOAuthBetaHeader(
  existingHeader: string | null,
  hasPdf: boolean,
): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (token: string) => {
    const t = token.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    ordered.push(t);
  };
  for (const b of CLAUDE_OAUTH_BETA.split(",")) push(b);
  if (hasPdf) push(CLAUDE_PDF_BETA);
  if (existingHeader) {
    for (const b of existingHeader.split(",")) push(b);
  }
  return ordered.join(",");
}

export function rewriteClaudeOAuthUrl(input: string): string {
  try {
    const u = new URL(input);
    if (u.pathname.endsWith("/v1/messages") && !u.searchParams.has("beta")) {
      u.searchParams.set("beta", "true");
    }
    return u.toString();
  } catch {
    return input.includes("/v1/messages") && !input.includes("?")
      ? `${input}?beta=true`
      : input;
  }
}

function applyClaudeOAuthHeaders(
  headers: Headers,
  accessToken: string,
  hasPdf: boolean,
): void {
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
  headers.set(
    "anthropic-beta",
    buildClaudeOAuthBetaHeader(headers.get("anthropic-beta"), hasPdf),
  );
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  headers.set("x-app", "cli");
  headers.set("user-agent", claudeCliUserAgent());
  headers.set("x-stainless-helper-method", "stream");
  headers.set("x-stainless-retry-count", "0");
  headers.set("x-stainless-runtime", "node");
  headers.set("x-stainless-runtime-version", "v24.14.0");
  headers.set("x-stainless-package-version", "0.80.0");
  headers.set("x-stainless-timeout", "600");
}

/**
 * Wraps fetch for Anthropic Claude OAuth calls:
 * - ensures `/v1/messages?beta=true`
 * - enforces Claude Code CLI User-Agent, beta flags, and Stainless headers
 * - injects `CLAUDE_CODE_IDENTITY` as system block 0
 * - refreshes OAuth token once on 401 and upgrades CLI version once on
 *   `claude_code_version_too_old`
 */
export function createClaudeOAuthFetch(
  baseFetch: typeof fetch,
  initialAccessToken: string,
  refreshAccess: () => Promise<string | null> = async () =>
    (await getOAuthAccess("claude-oauth", { forceRefresh: true }))?.accessToken ??
    null,
): typeof fetch {
  let currentToken = initialAccessToken;

  return async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = rewriteClaudeOAuthUrl(rawUrl);

    let bodyText: string | undefined;
    let hasPdf = false;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        parsed.system = withClaudeCodeIdentity(parsed.system);
        hasPdf = hasPdfDocumentInMessages(parsed.messages);
        bodyText = JSON.stringify(parsed);
      } catch {
        bodyText = init.body;
      }
    }

    const sendOnce = async (): Promise<Response> => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      applyClaudeOAuthHeaders(headers, currentToken, hasPdf);
      return baseFetch(url, {
        ...init,
        headers,
        body: bodyText ?? init?.body,
      });
    };

    let res = await sendOnce();

    if (res.status === 401) {
      const renewed = await refreshAccess();
      if (renewed) {
        currentToken = renewed;
        res = await sendOnce();
      }
    }

    if (res.status === 400 || res.status === 403 || res.status === 426) {
      const cloneText = await res
        .clone()
        .text()
        .catch(() => "");
      const minVer = extractClaudeCodeMinVersion(cloneText);
      if (minVer && minVer !== getClaudeCliVersion()) {
        learnedClaudeCliVersion = minVer;
        res = await sendOnce();
      }
    }

    return res;
  };
}
