/**
 * Request normalisation for Claude subscription (Claude Code OAuth) turns.
 *
 * Anthropic serves a subscription token only to Claude Code, and it checks
 * that by the system prompt: the FIRST system block must be exactly the Claude
 * Code identity, on its own. Anything else - a harness-profile prelude placed
 * before it, the identity merged into a longer block, or no identity at all -
 * is answered with `429 rate_limit_error "Error"`, which reads as a quota
 * problem but is a refusal, and retrying it never helps.
 *
 * The prompt is assembled in several places (the agent's stable prompt, the
 * profile prelude, per-step hints, sub-agents, compaction), so the guarantee
 * is enforced once, on the wire, the way ODON builds it in its provider.
 */

export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

type TextBlock = { type: "text"; text: string; [key: string]: unknown };

function isIdentityBlock(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as TextBlock).type === "text" &&
    typeof (block as TextBlock).text === "string" &&
    (block as TextBlock).text.trim() === CLAUDE_CODE_IDENTITY
  );
}

/**
 * The `system` value with the identity as its first block, alone and without
 * a cache marker, and no other copy of it. Pure, so the shape is pinned by a
 * test.
 */
export function withClaudeCodeIdentity(system: unknown): TextBlock[] {
  const identity: TextBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };
  if (typeof system === "string") {
    const rest = system.trim();
    if (!rest || rest === CLAUDE_CODE_IDENTITY) return [identity];
    const stripped = rest.startsWith(CLAUDE_CODE_IDENTITY)
      ? rest.slice(CLAUDE_CODE_IDENTITY.length).trim()
      : rest;
    return stripped ? [identity, { type: "text", text: stripped }] : [identity];
  }
  if (!Array.isArray(system)) return [identity];
  const others = system.filter((block) => !isIdentityBlock(block));
  return [identity, ...(others as TextBlock[])];
}

/**
 * Wraps a fetch so every Messages request carries the Claude Code identity as
 * its first system block. Anything that is not a JSON Messages call (token
 * counting, a non-JSON body) passes through untouched.
 */
export function createClaudeOAuthFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url;
    if (!/\/v1\/messages(?:\?|$)/.test(url) || typeof init?.body !== "string") {
      return inner(input, init);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return inner(input, init);
    }
    body.system = withClaudeCodeIdentity(body.system);
    return inner(input, { ...init, body: JSON.stringify(body) });
  };
}
