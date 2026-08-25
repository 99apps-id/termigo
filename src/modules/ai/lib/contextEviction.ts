import type { ModelMessage } from "ai";

export type EvictionSummary = {
  messagesProcessed: number;
  evictedToolCalls: number;
  estimatedTokensSaved: number;
};

/**
 * Pull the file path out of a `read_file` tool-result part.
 *
 * Two shapes exist in practice. Raw UI-derived parts carry `input.path`.
 * But by the time history reaches this function it has gone through the SDK's
 * `convertToModelMessages`, which drops `input` entirely and wraps the result
 * as `output: { type: "json" | "text", value }` - so the path lives inside
 * `output.value.path` there. Reading only `input.path` (the old behaviour)
 * matched nothing in the real flow and made eviction dead code.
 */
function readPath(part: { input?: unknown; output?: unknown }): string | null {
  const fromInput = (part.input as { path?: unknown } | undefined)?.path;
  if (typeof fromInput === "string") return fromInput;
  const out = part.output;
  if (out && typeof out === "object") {
    const wrapped = out as { path?: unknown; value?: unknown };
    const value = wrapped.value;
    if (value && typeof value === "object") {
      const p = (value as { path?: unknown }).path;
      if (typeof p === "string") return p;
    }
    if (typeof wrapped.path === "string") return wrapped.path;
  }
  return null;
}

/**
 * Prunes and evicts obsolete tool call outputs from message history.
 *
 * When an agent reads a file multiple times throughout a long turn,
 * older `read_file` outputs waste precious context tokens without providing value.
 * This function preserves the latest file read while collapsing older duplicate reads.
 */
export function evictObsoleteToolOutputs(
  messages: readonly ModelMessage[],
): { messages: ModelMessage[]; summary: EvictionSummary } {
  let evictedCount = 0;
  let estimatedTokens = 0;

  const seenReadPaths = new Set<string>();
  const cloned: ModelMessage[] = JSON.parse(JSON.stringify(messages));

  // Walk backwards from newest to oldest
  for (let i = cloned.length - 1; i >= 0; i--) {
    const msg = cloned[i];
    if (msg.role !== "tool") continue;

    if (Array.isArray(msg.content)) {
      for (const part of msg.content as { type: string; toolName?: string; input?: unknown; output?: unknown }[]) {
        if (part.type === "tool-result" && part.toolName === "read_file") {
          const path = readPath(part);
          if (path) {
            if (seenReadPaths.has(path)) {
              const prevOutput =
                typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output ?? "");
              estimatedTokens += Math.ceil(prevOutput.length / 4);
              // Keep the replacement strictly `{ type, value }`: the SDK's
              // tool-output shape has no room for extra keys, and a stray
              // `path` would travel into the provider payload for nothing.
              part.output = {
                type: "text",
                value: `[Older read_file output for ${path} evicted to save context]`,
              };
              evictedCount++;
            } else {
              seenReadPaths.add(path);
            }
          }
        }
      }
    }
  }

  return {
    messages: cloned,
    summary: {
      messagesProcessed: messages.length,
      evictedToolCalls: evictedCount,
      estimatedTokensSaved: estimatedTokens,
    },
  };
}
