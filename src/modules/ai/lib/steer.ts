// Steering a run that is already in flight.
//
// A request cannot be edited once it is sent, so "steer" here means holding the
// user's text until the current run ends and delivering it as the next turn.
// Before this, `submit` returned early while busy: anything typed during a run
// was silently dropped, keystrokes and attachments alike.
//
// Queue rather than interrupt, because a user who types while the agent works
// has not asked to throw that work away. Interrupting stays a deliberate act
// through the stop button, which flushes the queue after aborting.
//
// The queue holds whole messages rather than plain strings so an image or file
// attached mid-run survives the wait. It never inspects them; it is a buffer.

/**
 * One composed message part. Structural on purpose: this module stores parts
 * and hands them back untouched, so it has no business knowing the SDK's shape.
 */
export type SteerPart = { type: string; [key: string]: unknown };

export type SteerMessage = {
  /** Short text shown in the pending chip. */
  preview: string;
  /** Exactly what would have been sent, attachments included. */
  parts: readonly SteerPart[];
};

export type SteerQueue = { pending: readonly SteerMessage[] };

export const EMPTY_QUEUE: SteerQueue = { pending: [] };

/**
 * Whether a run is in flight.
 *
 * Two vocabularies reach this: the SDK's chat status (`submitted`) and the
 * app's own agent status (`thinking`). Both mean the same thing here, and
 * accepting both keeps callers from having to know which one they hold.
 */
export function isBusy(status: string): boolean {
  return status === "submitted" || status === "thinking" || status === "streaming";
}

/** Queue a message. One with no parts is ignored rather than stored. */
export function enqueue(queue: SteerQueue, message: SteerMessage): SteerQueue {
  if (message.parts.length === 0) return queue;
  return { pending: [...queue.pending, message] };
}

/** Drop one queued message; used by the per-message cancel in the UI. */
export function remove(queue: SteerQueue, index: number): SteerQueue {
  if (index < 0 || index >= queue.pending.length) return queue;
  return { pending: queue.pending.filter((_, i) => i !== index) };
}

/**
 * Take everything pending as one turn.
 *
 * Null when there is nothing to send, so callers branch once instead of
 * checking length separately. Parts are concatenated in order: sending each
 * queued message as its own run would have the agent answer the first without
 * ever seeing the rest.
 */
export function flush(
  queue: SteerQueue,
): { parts: SteerPart[]; next: SteerQueue } | null {
  if (queue.pending.length === 0) return null;
  return {
    parts: queue.pending.flatMap((m) => [...m.parts]),
    next: EMPTY_QUEUE,
  };
}

/** What submitting should do right now. */
export function submitAction(
  status: string,
  hasContent: boolean,
): "ignore" | "send" | "queue" {
  if (!hasContent) return "ignore";
  return isBusy(status) ? "queue" : "send";
}

/** One-line label for a queued message, for the pending chip. */
export function previewOf(parts: readonly SteerPart[], max = 80): string {
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const attachments = parts.filter((p) => p.type === "file").length;
  const label = text || (attachments > 0 ? `${attachments} attachment(s)` : "");
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** Prompt used to pick work back up after the user stopped the agent. */
export const RESUME_PROMPT =
  "Continue from where you stopped. Don't recap — just keep going.";
