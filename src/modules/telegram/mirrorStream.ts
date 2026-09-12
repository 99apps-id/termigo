// Streaming a mirrored assistant message into Telegram.
//
// The Termigo -> Telegram mirror used to hold every assistant message until the
// run settled (`if (m.role === "assistant" && !settled) continue;`). Because one
// assistant message accumulates ALL the steps of a run, and the mirror loop
// walks the transcript in order while a newer user message is delivered at once,
// the held reply arrived last and out of order: "output chat ditumpuk di
// belakang".
//
// The obvious fix - mirror immediately - is worse, and the reason is worth
// recording because it is a trap. `messageText()` joins every `text` part, so a
// streaming message's text GROWS; `markMessageSeen` records the message **id**
// and `isMessageSeen` returns true on the id alone. Send a partial message, mark
// it seen, and the completed answer can never be delivered: truncated replies.
//
// So the message is sent once and then EDITED in place while its text grows,
// which is what the other agent bots do (hermes, openclaw). The decision is a
// pure function over (text, settled, state, now) so the timing rules can be
// asserted without a network, a chat, or a fake clock.
//
// Deliberately NOT used: "finalize when the text has been quiet for N seconds".
// Provider latency on a real endpoint is 5-70s per step (observed in the field),
// so quiet text is the normal middle of a run, not its end - finalizing there
// would mark the message seen mid-run and silently drop the rest.

import { TELEGRAM_MAX_MESSAGE_CHARS } from "./telegramApi";

export type MirrorStreamState = {
  /** Telegram message id created for this transcript message. */
  messageId: number;
  /** The text already pushed to Telegram, so an edit is only sent on change. */
  pushed: string;
  /** When an edit last went out, for the rate-limit throttle. */
  lastEditAt: number;
  /**
   * The text outgrew one Telegram message. Streaming stops: there is nothing
   * useful to edit any more, and the whole answer is delivered by the settle
   * path, which chunks it.
   */
  overflow: boolean;
};

/**
 * Minimum gap between edits to the same message.
 *
 * Telegram rate-limits edits, and `editProgressMessage` already absorbs a short
 * 429 with a backoff, but the cheapest edit is the one not sent: a step that
 * emits three text parts should not become three API calls.
 */
export const MIRROR_EDIT_MIN_INTERVAL_MS = 2000;

/** What the caller should send, or null when nothing should be sent. */
export type MirrorSend = {
  kind: "start" | "edit" | "finalize" | "send";
  text: string;
};

export type MirrorPlan = {
  send: MirrorSend | null;
  /** Whether to record the transcript message as delivered. */
  markSeen: boolean;
  /** Streaming state to store, or null to clear it. */
  next: MirrorStreamState | null;
  /** True when the delivered text is whole, so diagrams may follow it. */
  complete: boolean;
};

/**
 * Decide what to do with one assistant message this tick.
 *
 * `state` is null until the first tick that has text to send; `settled` is the
 * run having reached `idle` or `error`, which is the only thing that ends the
 * editing. Callers assign the real `messageId` after `start` succeeds, which is
 * why `next.messageId` is 0 on that path.
 */
export function planMirrorDelivery(input: {
  text: string;
  settled: boolean;
  state: MirrorStreamState | null;
  now: number;
  limit?: number;
}): MirrorPlan {
  const limit = input.limit ?? TELEGRAM_MAX_MESSAGE_CHARS;
  const { text, settled, state, now } = input;

  if (!state) {
    if (text.length === 0) {
      // Nothing to show. Crucially NOT marked seen while the run is live: an
      // assistant message exists from its first reasoning part, so treating an
      // empty message as delivered would skip the answer that is about to
      // arrive in it.
      return {
        send: null,
        markSeen: settled,
        next: null,
        complete: settled,
      };
    }
    if (settled) {
      // The run is over, so this is the whole answer. One chunked send, never a
      // partial one.
      return { send: { kind: "send", text }, markSeen: true, next: null, complete: true };
    }
    if (text.length > limit) {
      // Too long to stream. Stay silent until it settles rather than sending a
      // prefix that can never be completed in place.
      return {
        send: null,
        markSeen: false,
        next: {
          messageId: 0,
          pushed: "",
          lastEditAt: now,
          overflow: true,
        },
        complete: false,
      };
    }
    return {
      send: { kind: "start", text },
      markSeen: false,
      next: {
        messageId: 0,
        pushed: text,
        lastEditAt: now,
        overflow: false,
      },
      complete: false,
    };
  }

  // Streaming already started for this message.
  if (state.overflow && !settled) {
    // Nothing edits cleanly once past the limit; wait for the settle path.
    return { send: null, markSeen: false, next: state, complete: false };
  }

  if (settled) {
    if (text.length === 0 || text === state.pushed) {
      return { send: null, markSeen: true, next: null, complete: true };
    }
    // No Telegram message exists when the text was already over the limit on
    // the first tick, so that case is a plain (chunked) send, not an edit.
    const hasMessage = state.messageId > 0;
    return {
      send: { kind: hasMessage ? "finalize" : "send", text },
      markSeen: true,
      next: null,
      complete: true,
    };
  }

  if (text === state.pushed) {
    return { send: null, markSeen: false, next: state, complete: false };
  }
  if (text.length > limit) {
    // Grew past one message mid-run: stop editing, let settle chunk it.
    return {
      send: null,
      markSeen: false,
      next: { ...state, overflow: true },
      complete: false,
    };
  }
  if (now - state.lastEditAt < MIRROR_EDIT_MIN_INTERVAL_MS) {
    // Throttled. Keep `pushed` as-is so the next allowed tick still sends the
    // newest text rather than skipping it.
    return { send: null, markSeen: false, next: state, complete: false };
  }
  return {
    send: { kind: "edit", text },
    markSeen: false,
    next: { ...state, pushed: text, lastEditAt: now },
    complete: false,
  };
}

/**
 * Record that a `start` succeeded, returning the state to store.
 *
 * A failed send returns null, and the caller must NOT mark the message seen:
 * the next tick retries, which is the same rule the one-shot mirror send has
 * always followed.
 */
export function startedState(
  messageId: number,
  plan: MirrorPlan,
): MirrorStreamState | null {
  if (!plan.next) return null;
  return { ...plan.next, messageId };
}

/**
 * Whether the final answer should complete the streamed message in place,
 * rather than be posted as a new message.
 *
 * This is the rule that stops the chat from showing the same answer twice: the
 * text has already been edited onto the screen while the run worked, so posting
 * it again duplicates it. Two cases force a fresh send instead:
 *
 * - a fallback status line is not the streamed answer, so it is always its own
 *   message;
 * - `messageId === 0` means no Telegram message was ever created (the text was
 *   over the limit from the first tick, so streaming was skipped deliberately).
 */
export function shouldFinalizeStream(
  state: MirrorStreamState | null,
  isFallback: boolean,
): state is MirrorStreamState {
  return !isFallback && state !== null && state.messageId > 0;
}
