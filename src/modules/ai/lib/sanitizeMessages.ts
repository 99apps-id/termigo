// Pure helper: close out unfinished tool calls in a chat history before the
// messages reach convertToModelMessages.
//
// A tool call that never produced a result makes the history invalid for every
// provider. OpenAI-compatible endpoints reject it outright with "An assistant
// message with 'tool_calls' must be followed by tool messages responding to
// each 'tool_call_id'", and the AI SDK raises "tool result is missing for tool
// call ...". It happens whenever a run stops between the call and its result:
// an approval left unanswered, a stopped stream, the app closed mid-run, or a
// session restored from disk and continued.
//
// Such a call is resolved rather than deleted. Deleting it keeps the provider
// happy but rewrites history: the model is shown a past in which it never made
// the call, so it cannot tell that its work was cut short and tends to repeat
// it. Marking the call as interrupted keeps the turn intact and lets the run
// pick up where it stopped, which is what the user's next message usually
// expects.
import type { UIMessage } from "ai";

type AnyPart = UIMessage["parts"][number];

const INTERRUPTED_TEXT =
  "Interrupted: this tool call was stopped before it produced a result.";

/**
 * Tool parts are named after the tool (`tool-read_file`), plus `dynamic-tool`
 * for ones resolved at runtime such as MCP. There is no single `tool` type to
 * compare against.
 */
function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

/**
 * States holding a call that has not produced a result: still waiting to run,
 * waiting on an approval nobody answered, or approved but never executed.
 *
 * `approval-responded` is the subtle one. While a run is being continued the
 * user has answered and the SDK is about to execute the call, so it must be
 * left alone - that is what this filter originally existed to protect. Once
 * the conversation has moved past that turn the call can never execute, and
 * leaving it is exactly what poisons a restored session.
 */
const UNFINISHED = new Set([
  "input-available",
  "approval-requested",
  "approval-responded",
]);

/**
 * Turn an unfinished call into a resolved one the provider will accept.
 *
 * The `approval` field has to go with it. `convertToModelMessages` emits a
 * `tool-approval-request` for any part still carrying one, and answers it only
 * when `approval.approved` is set - so a call interrupted while it was waiting
 * for an answer produced a request with no response, and the provider rejected
 * the whole message with "insufficient tool messages following tool_calls".
 * Marking the call errored while leaving the approval conversation half-open
 * described two different things at once.
 */
function closeAsInterrupted(part: AnyPart): AnyPart {
  const { approval: _approval, ...rest } = part as Record<string, unknown> & {
    approval?: unknown;
  };
  return {
    ...rest,
    state: "output-error",
    errorText: INTERRUPTED_TEXT,
  } as AnyPart;
}

/**
 * Index of the newest message that is not just the appended environment turn.
 *
 * The env block travels as a user turn of its own, added to the outgoing copy
 * on every request. Any decision about "what is at the end of this
 * conversation" has to look past it, or it answers a question about the
 * app's own bookkeeping instead of the conversation.
 */
function lastMeaningfulIndex(messages: readonly UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") return i;
    const text = m.parts
      .map((p) => (p as { type?: string; text?: string }))
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    if (text.replace(/<env>[\s\S]*?<\/env>/gi, " ").trim()) return i;
  }
  return -1;
}

export function sanitizeUiMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  // A run continued straight after an approval ends on the assistant turn that
  // holds it. Anything earlier - or any history that has since moved on to a
  // new user message - is settled and can no longer execute.
  //
  // The trailing environment turn does not count. It is appended to the
  // outgoing copy on every request, so measuring "is the last message an
  // assistant turn" against it answered no every single time: an approved call
  // was never recognised as live, every one was reported to the model as
  // interrupted, and the model reasonably tried again. That loop left 56 calls
  // stranded in `approval-responded` here, 37 of them `bash_run`.
  const liveIdx = lastMeaningfulIndex(messages);
  const continuingRun = liveIdx >= 0 && messages[liveIdx].role === "assistant";

  const out: UIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    const parts = message.parts.flatMap((part): AnyPart[] => {
      const type = (part as { type?: string }).type ?? "";
      if (!isToolPart(type)) return [part];
      const state = (part as { state?: string }).state ?? "";
      // The arguments were still streaming, so there is no complete call to
      // resolve - anything we emitted would carry truncated input.
      if (state === "input-streaming") return [];
      if (!UNFINISHED.has(state)) return [part];
      if (state === "approval-responded" && continuingRun && i === liveIdx) {
        return [part];
      }
      return [closeAsInterrupted(part)];
    });
    // An assistant turn left holding only a half-streamed call carries nothing
    // the model can use, and an empty turn is itself invalid for some providers.
    if (parts.length === 0) continue;
    out.push({ ...message, parts });
  }
  return out;
}
