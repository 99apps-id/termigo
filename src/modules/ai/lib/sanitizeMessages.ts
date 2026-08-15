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

/** Turn an unfinished call into a resolved one the provider will accept. */
function closeAsInterrupted(part: AnyPart): AnyPart {
  return {
    ...(part as Record<string, unknown>),
    state: "output-error",
    errorText: INTERRUPTED_TEXT,
  } as AnyPart;
}

export function sanitizeUiMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  const lastIdx = messages.length - 1;
  // A run continued straight after an approval ends on the assistant turn that
  // holds it. Anything earlier - or any history that has since moved on to a
  // new user message - is settled and can no longer execute.
  const continuingRun = messages[lastIdx]?.role === "assistant";

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
      if (state === "approval-responded" && continuingRun && i === lastIdx) {
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
