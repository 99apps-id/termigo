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
export type RepairSequenceOptions = {
  /** If true and the sequence ends with a trailing tool-approval-response, keep it intact for SDK execution. */
  preserveTrailingApproval?: boolean;
};

export function repairModelMessageSequence(
  messages: readonly ModelMessage[],
  options?: RepairSequenceOptions,
): ModelMessage[] {
  if (messages.length === 0) return [];

  const out: ModelMessage[] = [];
  let pendingToolCallIds = new Set<string>();
  let pendingToolCalls: Array<{ id: string; name: string }> = [];
  let pendingApprovalMap = new Map<string, string>();

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
        pendingApprovalMap.clear();
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
        pendingApprovalMap.clear();
      }

      const parts = partsOf(msg);
      const calls: Array<{ id: string; name: string }> = [];
      const approvalMap = new Map<string, string>();
      for (const p of parts) {
        if (p.type === "tool-call" && typeof p.toolCallId === "string") {
          calls.push({
            id: p.toolCallId,
            name: (p.toolName as string) ?? "tool",
          });
        } else if (
          p.type === "tool-approval-request" &&
          typeof p.approvalId === "string" &&
          typeof p.toolCallId === "string"
        ) {
          approvalMap.set(p.approvalId, p.toolCallId);
          if (!calls.some((c) => c.id === p.toolCallId)) {
            calls.push({
              id: p.toolCallId,
              name: (p.toolName as string) ?? "tool",
            });
          }
        }
      }

      out.push(msg);

      if (calls.length > 0) {
        pendingToolCallIds = new Set(calls.map((c) => c.id));
        pendingToolCalls = calls;
        pendingApprovalMap = approvalMap;
      }
      continue;
    }

    if (msg.role === "tool") {
      // If there are no pending tool calls from the immediately preceding assistant message,
      // this tool message is an ORPHAN (e.g. from history truncation, capping, or eviction).
      if (pendingToolCallIds.size === 0) {
        continue;
      }

      const isLastMessage = i === messages.length - 1;
      const preserveApprovals =
        isLastMessage && options?.preserveTrailingApproval !== false;

      const parts = partsOf(msg);
      const validParts: ContentPart[] = [];

      for (const p of parts) {
        if (p.type === "tool-result" && typeof p.toolCallId === "string") {
          if (pendingToolCallIds.has(p.toolCallId)) {
            validParts.push(p);
            pendingToolCallIds.delete(p.toolCallId);
            pendingToolCalls = pendingToolCalls.filter(
              (c) => c.id !== p.toolCallId,
            );
          }
        } else if (p.type === "tool-approval-response") {
          const callId =
            (typeof p.toolCallId === "string" ? p.toolCallId : undefined) ??
            (typeof p.approvalId === "string"
              ? pendingApprovalMap.get(p.approvalId)
              : undefined) ??
            (pendingToolCalls.length > 0 ? pendingToolCalls[0].id : undefined);

          if (callId && pendingToolCallIds.has(callId)) {
            const matchingCall = pendingToolCalls.find((c) => c.id === callId) ?? {
              id: callId,
              name: "tool",
            };

            if (preserveApprovals) {
              // Trailing approval resumption for SDK step 0
              validParts.push(p);
            } else {
              // Convert non-trailing or past tool-approval-response into a valid tool-result
              // so LLM providers (OpenAI/Anthropic/Gemini) that reject missing tool responses
              // receive a valid tool-result response.
              const syntheticResult: ToolResultPart = {
                type: "tool-result",
                toolCallId: callId,
                toolName: matchingCall.name,
                output:
                  p.approved === false
                    ? {
                        type: "error-text",
                        value:
                          (p.reason as string) ?? "Tool execution denied by user.",
                      }
                    : {
                        type: "error-text",
                        value:
                          "Interrupted: call was approved but interrupted before execution.",
                      },
              };
              validParts.push(syntheticResult as unknown as ContentPart);
            }

            pendingToolCallIds.delete(callId);
            pendingToolCalls = pendingToolCalls.filter((c) => c.id !== callId);
          }
        }
      }

      if (validParts.length === 0) {
        continue;
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
    pendingApprovalMap.clear();
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
