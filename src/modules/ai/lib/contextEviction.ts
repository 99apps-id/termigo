import type { ModelMessage } from "ai";

export type EvictionSummary = {
  messagesProcessed: number;
  evictedToolCalls: number;
  estimatedTokensSaved: number;
};

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
      for (const part of msg.content as any[]) {
        if (part.type === "tool-result" && part.toolName === "read_file") {
          const path = part.input?.path || part.output?.path;
          if (path) {
            if (seenReadPaths.has(path)) {
              const prevOutput = typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");
              estimatedTokens += Math.ceil(prevOutput.length / 4);
              part.output = {
                type: "text",
                value: `[Older read_file output for ${path} evicted to save context]`,
                path,
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
