import { CLAUDE_CLI_VERSION } from "../config";
import { getOAuthAccess } from "./oauthAuth";

export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// One pin for the whole TS side (config.ts owns it); the Rust and Go clients
// carry their own copies that must move with it.
export const CLAUDE_OAUTH_DEFAULT_CLI_VERSION = CLAUDE_CLI_VERSION;

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
 * Guarantees the identity leads the caller's system blocks, without
 * cache_control, and removes duplicate copies of it from subsequent blocks
 * (matching odon-ai and termixgo). The endpoint refuses a request whose first
 * block is neither the billing header nor this identity: measured on
 * 2026-11-27, `[custom]` and `[custom, identity]` answer 429 rate_limit_error,
 * while `[identity, custom]`, `[billing, custom]` and
 * `[billing, identity, custom]` are served. The billing block the fetch wrapper
 * prepends (see `claudeBillingHeader`) is the one block allowed in front.
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

/**
 * Whether a 400 is about extended thinking: an invalid or foreign `signature`
 * on a thinking block, a thinking block in the wrong place, or a thinking
 * type the model refuses ("thinking.type.disabled is not supported ...").
 */
export function isThinkingRejection(body: string): boolean {
  return /thinking/i.test(body) && /invalid_request_error/i.test(body);
}

/**
 * Removes every thinking block from the history and drops the `thinking` and
 * `context_management` parameters, leaving a short placeholder where a turn
 * would otherwise be empty (an empty content array is refused with 400). Role
 * alternation is kept. Returns whether anything changed.
 */
export function stripThinking(body: Record<string, unknown>): boolean {
  let changed = false;
  if ("thinking" in body) {
    delete body.thinking;
    changed = true;
  }
  if ("context_management" in body) {
    delete body.context_management;
    changed = true;
  }
  if (!Array.isArray(body.messages)) return changed;
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { content?: unknown };
    if (!Array.isArray(record.content)) continue;
    const kept = record.content.filter((block) => {
      const type = (block as { type?: unknown } | null)?.type;
      return type !== "thinking" && type !== "redacted_thinking";
    });
    if (kept.length === record.content.length) continue;
    changed = true;
    record.content =
      kept.length > 0 ? kept : [{ type: "text", text: "(thinking omitted)" }];
  }
  return changed;
}

/**
 * The endpoint refuses an empty turn: a text block with no text ("messages:
 * text content blocks must be non-empty") and a user message with no content
 * ("user messages must have non-empty content"), both measured. The AI SDK
 * drops an empty text PART but turns a message whose content is an empty
 * STRING into exactly such a block, and a turn like that stays in the history,
 * so every later request fails the same way and the run never recovers.
 *
 * Removes blank text blocks and any message left with nothing in it. A message
 * that carries a tool call, a tool result, a thinking block or an image is
 * never touched. Returns whether anything changed.
 */
export function dropEmptyTurns(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false;
  const isBlankText = (block: unknown): boolean => {
    const b = block as { type?: unknown; text?: unknown } | null;
    return (
      !!b &&
      b.type === "text" &&
      (typeof b.text !== "string" || b.text.trim() === "")
    );
  };
  let changed = false;
  const kept: unknown[] = [];
  for (const message of body.messages) {
    if (!message || typeof message !== "object") {
      kept.push(message);
      continue;
    }
    const record = message as { content?: unknown };
    const content = record.content;
    if (typeof content === "string") {
      if (content.trim() === "") {
        changed = true;
        continue;
      }
    } else if (Array.isArray(content)) {
      const blocks = content.filter((block) => !isBlankText(block));
      if (blocks.length !== content.length) {
        changed = true;
        record.content = blocks;
      }
      if (blocks.length === 0) {
        changed = true;
        continue;
      }
    }
    kept.push(message);
  }
  if (changed) body.messages = kept;
  return changed;
}

/**
 * Wraps `fetch` so a Messages request never carries an empty turn (see
 * `dropEmptyTurns`). This is for the API-key route: the endpoint's rule is the
 * API's, not OAuth's. The OAuth wrapper applies the same filter itself.
 */
export function withoutEmptyTurns(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        if (dropEmptyTurns(parsed)) {
          return baseFetch(input, { ...init, body: JSON.stringify(parsed) });
        }
      } catch {
        // Not JSON: nothing to filter, send it as it is.
      }
    }
    return baseFetch(input, init);
  };
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The constants the Claude Code client mixes into the build fingerprint it
 * advertises in its billing header. Recovered by matching the client's own
 * header for a known prompt: version 2.1.325 and the text "say hi" give `382`
 * (the same recovery, and the same constants, as termixgo's provider).
 */
const CLAUDE_FINGERPRINT_SALT = "59cf53e54c78";
const CLAUDE_FINGERPRINT_INDEXES = [4, 7, 20] as const;

/** Three hex characters: SHA-256 over the salt, the characters of the first
 *  user prompt at three fixed positions ("0" past the end) and the version. */
export async function claudeFingerprint(
  text: string,
  version: string,
): Promise<string> {
  const chars = [...text];
  const picked = CLAUDE_FINGERPRINT_INDEXES.map((i) => chars[i] ?? "0").join(
    "",
  );
  const hex = await sha256Hex(`${CLAUDE_FINGERPRINT_SALT}${picked}${version}`);
  return hex.slice(0, 3);
}

/**
 * The text the fingerprint is taken from: the first user message that carries
 * prose, as the client does. The harness appends an `<env>` block to a turn,
 * but the client fingerprints only the prompt, so that tail is cut off.
 */
export function claudeFingerprintText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "user") continue;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        const block = b as { type?: unknown; text?: unknown } | null;
        if (
          block &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim() !== ""
        ) {
          text = block.text;
          break;
        }
      }
    }
    if (!text.trim()) continue;
    const cut = text.lastIndexOf("\n<env>");
    if (cut >= 0 && text.slice(0, cut).trim()) return text.slice(0, cut).trim();
    return text;
  }
  return "";
}

/** The first system block of every Claude Code request. */
export async function claudeBillingHeader(
  messages: unknown,
  version = getClaudeCliVersion(),
): Promise<string> {
  const fingerprint = await claudeFingerprint(
    claudeFingerprintText(messages),
    version,
  );
  return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli;`;
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
 * The metadata.user_id the Claude Code client sends on a subscription request,
 * in the JSON shape it uses. Sent for parity with the client; a request without
 * it was served too (measured on 2026-11-27 across opus, sonnet and haiku 5.5),
 * so this is identity, not a gate. Mirrors
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
 * Suffixes the client's tool names. Names are also sanitized to the pattern
 * Anthropic accepts, since an MCP or extension name may carry dots, slashes
 * or spaces the suffix alone would leave in place. History tool_use blocks
 * are renamed to match. Returns the cloaked-to-original aliases for the
 * response stream.
 *
 * No decoy tools are offered. The Claude Code CLI lists only tools it serves,
 * and a decoy the model calls resolves to no client tool, which fails the
 * step instead of doing the work. Verified against the subscription endpoint
 * on 2026-11-27: a request carrying only suffixed (or plain) client tools,
 * with no decoys, is accepted and the model calls the tool.
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
  // The official client tags every request with a fresh id so a failure can be
  // traced server-side (the string is present in the 2.1.332 binary).
  headers.set(
    "x-client-request-id",
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `termigo-${Date.now().toString(36)}`,
  );
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
        dropEmptyTurns(parsed);
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
        // Built per attempt: the fingerprint carries the client version, which
        // a `claude_code_version_too_old` answer can change between attempts.
        const billing = {
          type: "text",
          text: await claudeBillingHeader(parsedBody.messages),
        };
        body = JSON.stringify({
          ...parsedBody,
          system: [
            billing,
            ...(Array.isArray(parsedBody.system) ? parsedBody.system : []),
          ],
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
      } else if (
        res.status === 400 &&
        parsedBody &&
        isThinkingRejection(cloneText)
      ) {
        // A history the thinking rules refuse (a block signed by another model
        // or altered by compaction, or a parameter this model will not take)
        // costs the whole turn. Repeat it once without thinking: dropping the
        // blocks was measured to be accepted on every current model.
        stripThinking(parsedBody);
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
