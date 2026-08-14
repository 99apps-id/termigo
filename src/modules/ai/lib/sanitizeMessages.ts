// Pure helper: drop dangling tool calls from a chat history before the messages
// reach convertToModelMessages.
//
// A tool call that never produced a result makes the history invalid for every
// provider. OpenAI-compatible endpoints reject it outright with "An assistant
// message with 'tool_calls' must be followed by tool messages responding to
// each 'tool_call_id'", and the AI SDK raises "tool result is missing for tool
// call ...". It happens whenever a run stops between the call and its result:
// an approval left unanswered, a stopped stream, the app closed mid-run, or a
// session restored from disk and continued.
//
// Only unresolved calls are removed, so the rest of the conversation survives.
import type { UIMessage } from "ai";

/**
 * Tool parts are named after the tool (`tool-read_file`), plus `dynamic-tool`
 * for ones resolved at runtime such as MCP. There is no single `tool` type to
 * compare against.
 */
function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

/**
 * States that can never resolve in a replayed history: the call was still
 * streaming its input, waiting to run, or waiting on an approval nobody
 * answered.
 *
 * `approval-responded` is deliberately not here. The user has answered and the
 * SDK still has to execute the call, so removing it would discard the decision
 * and break approvals mid-run, which is what this filter originally existed to
 * protect.
 */
const UNRESOLVABLE = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
]);

export function sanitizeUiMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  const out: UIMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    const parts = message.parts.filter((part) => {
      const type = (part as { type?: string }).type ?? "";
      if (!isToolPart(type)) return true;
      return !UNRESOLVABLE.has((part as { state?: string }).state ?? "");
    });
    // An assistant turn left holding only a dangling call carries nothing the
    // model can use, and an empty turn is itself invalid for some providers.
    if (parts.length === 0) continue;
    out.push({ ...message, parts });
  }
  return out;
}
