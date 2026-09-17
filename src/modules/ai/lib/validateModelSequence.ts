import type { ModelMessage, ToolModelMessage, ToolResultPart } from "ai";

type ContentPart = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
  input?: unknown;
  [k: string]: unknown;
};

function partsOf(m: ModelMessage): ContentPart[] {
  return Array.isArray(m.content) ? (m.content as ContentPart[]) : [];
}

/**
 * Validates and repairs a ModelMessage sequence before sending it to an LLM provider.
 *
 * Enforces universal provider invariants (OpenAI, Anthropic, Gemini, Groq, etc.):
 * 1. A 'tool' role message MUST directly follow an 'assistant' message that contains
 *    matching 'tool-call's. Any orphaned 'tool' message without a preceding
 *    'tool-call' causes a 400 Bad Request ("Messages with role 'tool' must be a
 *    response to a preceding message with 'tool_calls'").
 * 2. Every 'tool-call' in an 'assistant' message must have a corresponding 'tool-result'
 *    before the next non-tool message or end of history.
 * 3. The conversation must not start with a 'tool' message or an 'assistant' message.
 */
export function repairModelMessageSequence(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  if (messages.length === 0) return [];

  const out: ModelMessage[] = [];
  let pendingToolCallIds = new Set<string>();
  let pendingToolCalls: Array<{ id: string; name: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      // If previous assistant had unanswered tool calls, close them first
      if (pendingToolCallIds.size > 0) {
        const syntheticResults: ToolResultPart[] = pendingToolCalls.map(
          (tc) => ({
            type: "tool-result",
            toolCallId: tc.id,
            toolName: tc.name,
            output: {
              type: "error-text",
              value: "Interrupted: call was not completed before next turn.",
            },
          }),
        );
        out.push({
          role: "tool",
          content: syntheticResults,
        });
        pendingToolCallIds.clear();
        pendingToolCalls = [];
      }
      out.push(msg);
      continue;
    }

    if (msg.role === "assistant") {
      // If previous assistant had unanswered tool calls, close them first
      if (pendingToolCallIds.size > 0) {
        const syntheticResults: ToolResultPart[] = pendingToolCalls.map(
          (tc) => ({
            type: "tool-result",
            toolCallId: tc.id,
            toolName: tc.name,
            output: {
              type: "error-text",
              value: "Interrupted: call was not completed before next turn.",
            },
          }),
        );
        out.push({
          role: "tool",
          content: syntheticResults,
        });
        pendingToolCallIds.clear();
        pendingToolCalls = [];
      }

      const parts = partsOf(msg);
      const calls: Array<{ id: string; name: string }> = [];
      for (const p of parts) {
        if (p.type === "tool-call" && typeof p.toolCallId === "string") {
          calls.push({
            id: p.toolCallId,
            name: (p.toolName as string) ?? "tool",
          });
        }
      }

      out.push(msg);

      if (calls.length > 0) {
        pendingToolCallIds = new Set(calls.map((c) => c.id));
        pendingToolCalls = calls;
      }
      continue;
    }

    if (msg.role === "tool") {
      // If there are no pending tool calls from the immediately preceding assistant message,
      // this tool message is an ORPHAN (e.g. from history truncation, capping, or eviction).
      // Sending it would cause: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
      if (pendingToolCallIds.size === 0) {
        // Drop orphaned tool message
        continue;
      }

      const parts = partsOf(msg);
      // Keep only parts that answer a known pending tool call
      const validParts = parts.filter((p) => {
        if (p.type !== "tool-result" || typeof p.toolCallId !== "string") {
          return false;
        }
        return pendingToolCallIds.has(p.toolCallId);
      });

      if (validParts.length === 0) {
        // None of the parts answer a known pending tool call from this turn
        continue;
      }

      for (const vp of validParts) {
        if (typeof vp.toolCallId === "string") {
          pendingToolCallIds.delete(vp.toolCallId);
          pendingToolCalls = pendingToolCalls.filter(
            (c) => c.id !== vp.toolCallId,
          );
        }
      }

      out.push({
        ...msg,
        content: validParts as unknown as ToolResultPart[],
      } as ToolModelMessage);
      continue;
    }

    // System or other roles
    out.push(msg);
  }

  // If the sequence ends with unanswered tool calls (e.g. process was killed or interrupted mid-turn),
  // synthesize results so providers don't reject with:
  // "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'".
  if (pendingToolCallIds.size > 0) {
    const syntheticResults: ToolResultPart[] = pendingToolCalls.map((tc) => ({
      type: "tool-result",
      toolCallId: tc.id,
      toolName: tc.name,
      output: {
        type: "error-text",
        value: "Interrupted: call was not completed before run ended.",
      },
    }));
    out.push({
      role: "tool",
      content: syntheticResults,
    });
    pendingToolCallIds.clear();
    pendingToolCalls = [];
  }

  // Ensure first message is not 'tool' (fail-closed safety check)
  while (out.length > 0 && out[0].role === "tool") {
    out.shift();
  }

  // Ensure conversation doesn't start with 'assistant'
  if (out.length > 0 && out[0].role === "assistant") {
    out.unshift({
      role: "user",
      content: "[Continuing previous task]",
    });
  }

  return out;
}
