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
export function evictObsoleteToolOutputs(messages: readonly ModelMessage[]): {
  messages: ModelMessage[];
  summary: EvictionSummary;
} {
  let evictedCount = 0;
  let estimatedTokens = 0;

  const seenReadPaths = new Set<string>();
  // Copy-on-write: only a message whose output is actually rewritten is
  // rebuilt. This used to deep-clone the whole transcript through
  // `JSON.parse(JSON.stringify(...))`, which serialized every message on every
  // model call, handed back a new array identity even when nothing was
  // evicted, and dropped anything JSON cannot carry (Uint8Array image data,
  // undefined, class instances).
  const out: ModelMessage[] = messages.slice();
  let rebuilt = false;

  // Walk backwards from newest to oldest. Both loops must go newest-first:
  // an auto-continuing turn collapses its whole tool history into ONE message
  // (the 0.9.10 log shape: 15 read_file parts in one 24 KB message), and a
  // forward walk over the parts array would evict the NEWEST duplicate and
  // keep the stale one - backwards.
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (msg.role !== "tool") continue;

    if (Array.isArray(msg.content)) {
      const parts = msg.content as {
        type: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
      }[];
      let nextParts: typeof parts | null = null;
      for (let p = parts.length - 1; p >= 0; p--) {
        const part = parts[p];
        if (part.type === "tool-result" && part.toolName === "read_file") {
          const path = readPath(part);
          if (path) {
            const pathKey = path.replace(/\\/g, "/").toLowerCase();
            if (seenReadPaths.has(pathKey)) {
              const prevOutput =
                typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output ?? "");
              estimatedTokens += Math.ceil(prevOutput.length / 4);
              // Keep the replacement strictly `{ type, value }`: the SDK's
              // tool-output shape has no room for extra keys, and a stray
              // `path` would travel into the provider payload for nothing.
              // The part is copied, never written in place, so the caller's
              // transcript is left untouched without cloning all of it.
              if (!nextParts) nextParts = parts.slice();
              nextParts[p] = {
                ...part,
                output: {
                  type: "text",
                  value: `[Older read_file output for ${path} evicted to save context]`,
                },
              };
              evictedCount++;
            } else {
              seenReadPaths.add(pathKey);
            }
          }
        }
      }
      if (nextParts) {
        out[i] = { ...msg, content: nextParts } as ModelMessage;
        rebuilt = true;
      }
    }
  }

  return {
    messages: rebuilt ? out : (messages as ModelMessage[]),
    summary: {
      messagesProcessed: messages.length,
      evictedToolCalls: evictedCount,
      estimatedTokensSaved: estimatedTokens,
    },
  };
}
