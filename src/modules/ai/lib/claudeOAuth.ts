import { getOAuthAccess } from "./oauthAuth";

export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_OAUTH_DEFAULT_CLI_VERSION = "2.1.325";

export const CLAUDE_OAUTH_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";

export const CLAUDE_PDF_BETA = "pdfs-2024-09-25";

let learnedClaudeCliVersion: string | null = null;

export function getClaudeCliVersion(): string {
  return learnedClaudeCliVersion ?? CLAUDE_OAUTH_DEFAULT_CLI_VERSION;
}

export function setClaudeCliVersionForTests(version: string | null): void {
  learnedClaudeCliVersion = version;
}

export function claudeCliUserAgent(version = getClaudeCliVersion()): string {
  return `claude-cli/${version} (external, cli)`;
}

export function extractClaudeCodeMinVersion(body: string): string | null {
  if (!body.includes("claude_code_version_too_old")) return null;
  const match =
    body.match(
      /minimum(?:\s+required)?\s+version(?:\s+is)?\s+v?(\d+\.\d+\.\d+)/i,
    ) ??
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
export function withClaudeCodeIdentity(
  system: unknown,
): AnthropicSystemBlock[] {
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
      if (
        block.type === "text" &&
        block.text?.trim() === CLAUDE_CODE_IDENTITY
      ) {
        continue;
      }
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        !block.text.trim()
      ) {
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

export const CLAUDE_TOOL_SUFFIX = "_ide";

const CLAUDE_DECOY_TOOL_NAMES = [
  "Task",
  "TaskOutput",
  "TaskStop",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uuidFromHex(hex: string): string {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const s = chars.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

async function uuidFromSeed(seed: string): Promise<string> {
  return uuidFromHex(await sha256Hex(seed));
}

/**
 * The metadata.user_id Anthropic requires on a subscription request, in the
 * JSON shape the Claude Code client sends. Without it the Messages endpoint
 * answers 400 invalid_request_error even for a healthy login. Mirrors
 * claudeUserID in cli/internal/provider/anthropic.go.
 */
export async function claudeOAuthUserId(
  accessToken: string,
  sessionId: string,
): Promise<string> {
  const [deviceId, accountUuid, sessionUuid] = await Promise.all([
    sha256Hex(`device:${accessToken}`),
    uuidFromSeed(`account:${accessToken}`),
    uuidFromSeed(`session:${sessionId}`),
  ]);
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionUuid,
  });
}

/**
 * The only shape Anthropic accepts for a tool name. A name outside it (an
 * MCP name with a dot or slash, a server name with a space) is answered with
 * 400 invalid_request_error naming this exact pattern, verified live.
 */
export function sanitizeClaudeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return cleaned || "tool";
}

function cloakOne(
  name: string,
  aliases: Map<string, string>,
  present: Set<string>,
): string {
  let cloaked = sanitizeClaudeToolName(name);
  if (!cloaked.endsWith(CLAUDE_TOOL_SUFFIX)) {
    cloaked = sanitizeClaudeToolName(`${cloaked}${CLAUDE_TOOL_SUFFIX}`);
  }
  if (present.has(cloaked) && aliases.get(cloaked) !== name) {
    let n = 2;
    let candidate = sanitizeClaudeToolName(`${cloaked}_${n}`);
    while (present.has(candidate) && aliases.get(candidate) !== name) {
      n += 1;
      candidate = sanitizeClaudeToolName(`${cloaked}_${n}`);
    }
    cloaked = candidate;
  }
  present.add(cloaked);
  aliases.set(cloaked, name);
  return cloaked;
}

/**
 * Suffixes the client's tool names and appends the Claude Code decoy tools:
 * the subscription endpoint expects the CLI's tool surface, and a foreign
 * tool name is answered with 400. Names are also sanitized to the pattern
 * Anthropic accepts, since an MCP or extension name may carry dots, slashes
 * or spaces the suffix alone would leave in place. History tool_use blocks
 * are renamed to match. Returns the cloaked-to-original aliases for the
 * response stream.
 */
export function cloakClaudeToolNames(
  body: Record<string, unknown>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const present = new Set<string>();
  if (Array.isArray(body.tools)) {
    const cloaked: unknown[] = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") {
        cloaked.push(tool);
        continue;
      }
      const record = tool as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      if (!name) {
        cloaked.push(tool);
        continue;
      }
      cloaked.push({ ...record, name: cloakOne(name, aliases, present) });
    }
    for (const decoy of CLAUDE_DECOY_TOOL_NAMES) {
      if (present.has(decoy)) continue;
      cloaked.push({
        name: decoy,
        description: "This tool is currently unavailable.",
        input_schema: { type: "object", properties: {} },
      });
    }
    body.tools = cloaked;
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== "object") continue;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        if (record.type !== "tool_use") continue;
        const name = typeof record.name === "string" ? record.name : "";
        if (!name || aliases.has(name)) continue;
        const known = [...aliases.entries()].find(
          ([, original]) => original === name,
        );
        record.name = known ? known[0] : cloakOne(name, aliases, present);
      }
    }
  }
  return aliases;
}

/** Renames cloaked tool names back on the streamed tool_use blocks. */
function renameCloakedStream(
  stream: ReadableStream<Uint8Array>,
  aliases: Map<string, string>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const rewrite = (line: string): string => {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("data:")) return line;
    try {
      const event = JSON.parse(trimmed.slice("data:".length)) as {
        content_block?: { type?: string; name?: string };
      };
      const block = event.content_block;
      if (block?.type === "tool_use" && block.name) {
        const original = aliases.get(block.name);
        if (original) {
          block.name = original;
          return `data: ${JSON.stringify(event)}\n`;
        }
      }
    } catch {
      // Not a JSON data line: pass it through untouched.
    }
    return line;
  };
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          controller.enqueue(
            encoder.encode(rewrite(buffer.slice(0, index + 1))),
          );
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
      },
    }),
  );
}

function applyClaudeOAuthHeaders(
  headers: Headers,
  accessToken: string,
  hasPdf: boolean,
  sessionId?: string,
): void {
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.set(
    "anthropic-version",
    headers.get("anthropic-version") ?? "2023-06-01",
  );
  headers.set(
    "anthropic-beta",
    buildClaudeOAuthBetaHeader(headers.get("anthropic-beta"), hasPdf),
  );
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  headers.set("x-app", "cli");
  headers.set("user-agent", claudeCliUserAgent());
  headers.set("x-stainless-retry-count", "0");
  headers.set("x-stainless-runtime", "node");
  headers.set("x-stainless-runtime-version", "v26.12.1");
  headers.set("x-stainless-package-version", "0.128.0");
  headers.set("x-stainless-timeout", "600");
  headers.set("x-stainless-lang", "js");
  if (sessionId) headers.set("x-claude-code-session-id", sessionId);
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
    (await getOAuthAccess("claude-oauth"))?.accessToken ?? null,
): typeof fetch {
  let currentToken = initialAccessToken;
  const sessionId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "termigo-claude-oauth";

  return async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = rewriteClaudeOAuthUrl(rawUrl);

    let parsedBody: Record<string, unknown> | null = null;
    let aliases = new Map<string, string>();
    let hasPdf = false;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        parsed.system = withClaudeCodeIdentity(parsed.system);
        hasPdf = hasPdfDocumentInMessages(parsed.messages);
        aliases = cloakClaudeToolNames(parsed);
        parsedBody = parsed;
      } catch {
        parsedBody = null;
      }
    }

    const sendOnce = async (): Promise<Response> => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const sessionUuid = await uuidFromSeed(`session:${sessionId}`);
      applyClaudeOAuthHeaders(headers, currentToken, hasPdf, sessionUuid);
      let body = init?.body;
      if (parsedBody) {
        const userId = await claudeOAuthUserId(currentToken, sessionId);
        body = JSON.stringify({
          ...parsedBody,
          metadata: {
            ...((parsedBody.metadata as Record<string, unknown>) ?? {}),
            user_id: userId,
          },
        });
      }
      return baseFetch(url, { ...init, headers, body });
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

    if (
      aliases.size > 0 &&
      res.ok &&
      res.body &&
      (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ) {
      return new Response(renameCloakedStream(res.body, aliases), {
        status: res.status,
        statusText: res.statusText,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return res;
  };
}
