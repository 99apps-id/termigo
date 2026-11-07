// Turn-continuation semantics, ported from ODON's `odon-agent/src/continuation.rs`.
//
// Three ways a model turn ends without finishing the task, none of which looks
// like a failure to the caller:
//
//  1. The output budget ran out mid-answer, so the cut text would otherwise be
//     taken as the complete reply.
//  2. The turn streamed only reasoning and closed with neither prose nor a tool
//     call, which the operator sees as "[The model returned no reply]".
//  3. The model announced its next step ("Next I'll inspect...") and issued no
//     tool call, so the loop ended with the task stranded and nothing failed.
//
// Where this runs matters. In the AI SDK a following step happens only after a
// step that made tool calls, so a turn that ends WITHOUT one never reaches
// `prepareStep` again. The decision therefore belongs at the end of the run
// (see chatRuntime `requestContinuationNudge`), which sends one bounded
// synthetic follow-up, the same way the verify-on-stop gate does.

/** Shortest repeated run worth de-duplicating. Below this, matching is noise. */
export const MIN_CONTINUATION_OVERLAP = 24;

/** How many times one task may resume after the output budget cut an answer. */
export const MAX_TRUNCATION_CONTINUATIONS = 4;

/** How many empty-reply continuations one task may trigger. */
export const MAX_EMPTY_REPLY_CONTINUATIONS = 2;

/** How many promised-action continuations one task may trigger. */
export const MAX_PROMISED_ACTION_CONTINUATIONS = 2;

/** Marks a synthetic continuation message so it can be told from a user task:
 *  it keeps the todo list and the auto-continue budget, and gets no rewind
 *  checkpoint. One prefix for all three kinds keeps detection in one place. */
export const CONTINUATION_NUDGE_PREFIX = "[System: continuation]";

/** Only the tail of a reply is inspected for a promise: a complete answer may
 *  explain "the next step" earlier and still be finished. */
const PROMISE_TAIL_CHARS = 500;

/** A reply longer than this is never read as a promise; a long answer is
 *  finished work, not a stranded one. */
const MAX_PROMISE_TEXT_CHARS = 2_000;

/** How much of an announced action is quoted back to the model. */
const PROMISE_QUOTE_CHARS = 280;

/** Appended when the output budget cut the answer. The cut text is already in
 *  the history as the previous assistant message, so it is not quoted again. */
export const OUTPUT_LIMIT_NUDGE =
  "Your previous message was cut off by the output limit, not by the end of the task. Continue exactly where you stopped. Do not repeat the text you already produced, do not restart the answer, and do not summarise what you did. If a tool call was cut off mid-argument, issue that tool call again with complete arguments.";

/** Appended when the model announced a next step but never took it. */
export const PROMISED_ACTION_NUDGE =
  "Your previous message announced the next step but contained no tool call, so the turn ended with the task still unfinished. Act now: issue the tool call you announced. If the task is genuinely finished, say so plainly instead of promising more work.";

/** Appended when the model streamed only reasoning and no answer. */
export const EMPTY_REPLY_NUDGE =
  "Your previous step ended without a tool call and without a final answer; its output budget was consumed by reasoning. Resume the task from the work already done: if you still need information, issue the next tool call now; otherwise write the final response now. Do not repeat tool calls that already succeeded, and do not restart the task.";

const PROMISE_PHRASES = [
  "next i'll",
  "next, i'll",
  "next i will",
  "next i am going to",
  "i'll now ",
  "i will now ",
  "let me now ",
  "let me check",
  "let me look",
  "let me inspect",
  "let me read",
  "let me run",
  "let me search",
  "let me examine",
  "let me verify",
  "let me open",
  "let me find",
  "i'm going to check",
  "i'm going to inspect",
  "i'm going to read",
  "i'm going to run",
  "i'm going to search",
  "saya lanjut",
  "saya akan lanjut",
  "selanjutnya saya",
  "mari saya cek",
  "mari saya periksa",
  "mari saya lihat",
  "mari saya baca",
  "saya cek ",
  "saya periksa ",
  "saya baca ",
  "saya jalankan ",
];

const COMPLETION_PHRASES = [
  "done",
  "selesai",
  "finished",
  "complete",
  "no further",
  "that's all",
  "itu saja",
  "sudah selesai",
];

/**
 * True when a reply ends by announcing a concrete next action instead of
 * taking it. The phrases are deliberately concrete so a closing courtesy such
 * as "let me know" is not mistaken for unfinished work.
 */
export function promisesNextAction(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const chars = Array.from(trimmed.toLowerCase());
  if (chars.length > MAX_PROMISE_TEXT_CHARS) return false;
  const tail = chars
    .slice(Math.max(0, chars.length - PROMISE_TAIL_CHARS))
    .join("");
  return (
    PROMISE_PHRASES.some((phrase) => tail.includes(phrase)) &&
    !COMPLETION_PHRASES.some((phrase) => tail.includes(phrase))
  );
}

/**
 * Longest prefix of `continuation` that repeats the suffix of `previous`.
 *
 * KMP prefix function, so the cost is linear in the input length rather than
 * the quadratic cost of testing every suffix. Works on UTF-16 code units and
 * returns a length that is always a valid slice boundary for them.
 */
export function continuationOverlapLength(
  previous: string,
  continuation: string,
): number {
  if (
    previous.length < MIN_CONTINUATION_OVERLAP ||
    continuation.length < MIN_CONTINUATION_OVERLAP
  ) {
    return 0;
  }

  const prefix = new Array<number>(continuation.length).fill(0);
  let matched = 0;
  for (let i = 1; i < continuation.length; i++) {
    while (matched > 0 && continuation[i] !== continuation[matched]) {
      matched = prefix[matched - 1];
    }
    if (continuation[i] === continuation[matched]) matched++;
    prefix[i] = matched;
  }

  matched = 0;
  for (let i = 0; i < previous.length; i++) {
    while (matched > 0 && previous[i] !== continuation[matched]) {
      matched = prefix[matched - 1];
    }
    if (previous[i] === continuation[matched]) matched++;
    if (matched === continuation.length) matched = prefix[matched - 1];
  }

  // A boundary inside a surrogate pair would leave half a character behind.
  // Dropping one unit from the match would no longer be a suffix of `previous`,
  // so such a (very rare) seam is simply not stripped.
  if (matched > 0 && matched < continuation.length) {
    const code = continuation.charCodeAt(matched);
    if (code >= 0xdc00 && code <= 0xdfff) return 0;
  }
  return matched >= MIN_CONTINUATION_OVERLAP ? matched : 0;
}

/** Which continuation, if any, a finished run calls for. */
export type ContinuationKind = "truncation" | "empty-reply" | "promised-action";

export type ContinuationState = {
  truncations: number;
  emptyReplies: number;
  promisedActions: number;
};

export function newContinuationState(): ContinuationState {
  return { truncations: 0, emptyReplies: 0, promisedActions: 0 };
}

/** The provider's own "output budget ran out" signal. Checking it rather than
 *  guessing from the text keeps a genuinely finished long answer from being
 *  resumed. */
export function isTruncatedFinish(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  return (
    finishReason === "length" ||
    finishReason === "maxTokens" ||
    finishReason.startsWith("max_tokens")
  );
}

/**
 * Decide whether the run that just ended needs one nudge to actually finish.
 *
 * Order matters. A truncated finish is checked first because the cut can land
 * inside reasoning or a tool call's arguments, leaving NO text; reading that as
 * an empty reply would ask the model to "write the final answer" instead of
 * resuming what was cut. A finish that is an error, a content-filter refusal,
 * or a tool-calls stop (a guard ended a run mid-work) is not a stranded task
 * and is never nudged.
 */
export function continuationDecision(input: {
  lastStepText: string;
  finishReason: string | undefined;
  usedToolsThisRun: boolean;
  state: ContinuationState;
}): ContinuationKind | null {
  const { lastStepText, finishReason, usedToolsThisRun, state } = input;
  if (
    finishReason === "error" ||
    finishReason === "content-filter" ||
    finishReason === "tool-calls"
  ) {
    return null;
  }
  if (isTruncatedFinish(finishReason)) {
    return state.truncations < MAX_TRUNCATION_CONTINUATIONS
      ? "truncation"
      : null;
  }
  const text = lastStepText.trim();
  if (text.length === 0) {
    return state.emptyReplies < MAX_EMPTY_REPLY_CONTINUATIONS
      ? "empty-reply"
      : null;
  }
  if (usedToolsThisRun && promisesNextAction(text)) {
    return state.promisedActions < MAX_PROMISED_ACTION_CONTINUATIONS
      ? "promised-action"
      : null;
  }
  return null;
}

/** The synthetic message for a continuation, carrying the shared prefix. */
export function buildContinuationNudge(
  kind: ContinuationKind,
  lastStepText: string,
): string {
  switch (kind) {
    case "truncation":
      return `${CONTINUATION_NUDGE_PREFIX} ${OUTPUT_LIMIT_NUDGE}`;
    case "empty-reply":
      return `${CONTINUATION_NUDGE_PREFIX} ${EMPTY_REPLY_NUDGE}`;
    case "promised-action": {
      const chars = Array.from(lastStepText.trim());
      const tail = chars
        .slice(Math.max(0, chars.length - PROMISE_QUOTE_CHARS))
        .join("");
      return `${CONTINUATION_NUDGE_PREFIX} ${PROMISED_ACTION_NUDGE}\n\nYou announced: "${tail}"`;
    }
  }
}

/** Record that a nudge of `kind` is being sent. Pure: returns the next state. */
export function recordContinuation(
  state: ContinuationState,
  kind: ContinuationKind,
): ContinuationState {
  switch (kind) {
    case "truncation":
      return { ...state, truncations: state.truncations + 1 };
    case "empty-reply":
      return { ...state, emptyReplies: state.emptyReplies + 1 };
    case "promised-action":
      return { ...state, promisedActions: state.promisedActions + 1 };
  }
}

/** Whether a send is a continuation nudge (same-task semantics). */
export function isContinuationNudgeParts(
  parts: readonly { type: string; text?: unknown }[],
): boolean {
  if (parts.length !== 1) return false;
  const first = parts[0];
  return (
    first?.type === "text" &&
    typeof first.text === "string" &&
    first.text.startsWith(CONTINUATION_NUDGE_PREFIX)
  );
}

type PartLike = { type: string; text?: unknown };
type MessageLike = { role: string; parts: PartLike[] };

/**
 * Strip the repeated seam from a resumed answer in the OUTGOING history.
 *
 * A resumed turn usually repeats the tail of the answer it continues. The
 * nudge asks it not to, but when it does the duplicate would ride in every
 * later request. The pattern is exact: an assistant message cut by the output
 * limit, the truncation nudge, then the assistant message that resumed it.
 * Only the copy sent to the provider is rewritten, never the stored chat.
 * Returns the same array when there is nothing to strip.
 */
export function dedupeResumedSeams<M extends MessageLike>(
  messages: readonly M[],
): M[] {
  let out: M[] | null = null;
  for (let i = 0; i + 2 < messages.length; i++) {
    const [cut, nudge, resumed] = [
      messages[i],
      messages[i + 1],
      messages[i + 2],
    ];
    if (cut.role !== "assistant" || nudge.role !== "user") continue;
    if (resumed.role !== "assistant") continue;
    if (!isContinuationNudgeParts(nudge.parts)) continue;
    const nudgeText = String(nudge.parts[0]?.text ?? "");
    if (!nudgeText.includes(OUTPUT_LIMIT_NUDGE)) continue;

    const cutIndex = lastTextIndex(cut.parts);
    const resumedIndex = firstTextIndex(resumed.parts);
    if (cutIndex < 0 || resumedIndex < 0) continue;
    const before = String(cut.parts[cutIndex].text ?? "");
    const after = String(resumed.parts[resumedIndex].text ?? "");
    const overlap = continuationOverlapLength(before, after);
    if (overlap <= 0) continue;

    out ??= messages.slice();
    const parts = resumed.parts.slice();
    parts[resumedIndex] = {
      ...parts[resumedIndex],
      text: after.slice(overlap),
    };
    out[i + 2] = { ...resumed, parts };
  }
  return out ?? messages.slice();
}

function lastTextIndex(parts: readonly PartLike[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === "text" && typeof parts[i].text === "string") return i;
  }
  return -1;
}

function firstTextIndex(parts: readonly PartLike[]): number {
  return parts.findIndex(
    (p) => p.type === "text" && typeof p.text === "string",
  );
}

const CONTINUE_INTENTS = new Set([
  "continue",
  "lanjut",
  "lanjutkan",
  "go on",
  "keep going",
  "carry on",
  "resume",
  "teruskan",
]);

/**
 * True when a user message is nothing but a request to carry on. Such a
 * message is better sent as a resume of the previous turn than as a fresh task
 * with no content: it keeps the todo list and the auto-continue budget.
 * Deliberately narrow: "next" and similar are real words in other contexts.
 */
export function trailingContinueIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const normalised = trimmed
    .replace(/[.!?]+\s*$/u, "")
    .trim()
    .toLowerCase();
  return CONTINUE_INTENTS.has(normalised);
}
