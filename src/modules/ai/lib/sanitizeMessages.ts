// Pure helper: drop dangling tool invocations from a chat history before the
// messages reach convertToModelMessages.
//
// The AI SDK throws "tool result is missing for tool call ..." when an
// assistant message carries a tool call whose result was never created.
// That happens when an approval is left unanswered (stream ended, tab
// switched, run interrupted) or a session with a pending approval is
// restored from disk. This filter removes only the parts that can never be
// resolved, keeping the conversation usable for every provider.
import type { UIMessage } from "ai";

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
      if (part.type !== "tool-invocation") return true;
      const state = (part as { state?: string }).state;
      return state !== "input" && state !== "approval-requested";
    });
    // An assistant turn that only contained a dangling tool call carries no
    // information; drop it entirely so the model never sees an empty turn.
    if (parts.length === 0) continue;
    out.push({ ...message, parts });
  }
  return out;
}
