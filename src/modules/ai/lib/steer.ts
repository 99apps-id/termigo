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
  return (
    status === "submitted" ||
    status === "thinking" ||
    status === "streaming" ||
    status === "awaiting-approval"
  );
}

/** Queue a message. One with no parts is ignored rather than stored. */
export function enqueue(queue: SteerQueue, message: SteerMessage): SteerQueue {
  if (message.parts.length === 0) return queue;
  return { pending: [...queue.pending, message] };
}

/** Put a failed delivery back before messages typed while it was sending. */
export function prepend(queue: SteerQueue, message: SteerMessage): SteerQueue {
  if (message.parts.length === 0) return queue;
  return { pending: [message, ...queue.pending] };
}

/** Drop one queued message; used by the per-message cancel in the UI. */
export function remove(queue: SteerQueue, index: number): SteerQueue {
  if (index < 0 || index >= queue.pending.length) return queue;
  return { pending: queue.pending.filter((_, i) => i !== index) };
}

/**
 * Replace one queued message in place. Used by the strip's edit action: the
 * text goes back to the composer while any attachments stay queued at the same
 * position, so a re-queue does not shuffle the send order.
 */
export function replaceAt(
  queue: SteerQueue,
  index: number,
  message: SteerMessage | null,
): SteerQueue {
  if (index < 0 || index >= queue.pending.length) return queue;
  const next = queue.pending.filter((_, i) => i !== index);
  if (message && message.parts.length > 0) next.splice(index, 0, message);
  return { pending: next };
}

/**
 * How many queued rows the strip shows before collapsing the rest into an
 * "…and N more" tail. A long queue must not eat the composer: the strip is a
 * status line, not a document. Ported from Hermes' QUEUE_WINDOW.
 */
export const QUEUE_WINDOW = 3;

export type QueueWindow = {
  /** First index shown. */
  start: number;
  /** One past the last index shown. */
  end: number;
  /** True when rows before `start` are hidden (render a leading ellipsis). */
  showLead: boolean;
  /** True when rows from `end` on are hidden (render a trailing count). */
  showTail: boolean;
};

/**
 * Which slice of the queue the strip renders.
 *
 * Normally the OLDEST rows (they send first). When a row is being edited the
 * window slides so that row stays visible — the user must never watch the row
 * they are working on scroll out of view. Ported from Hermes' getQueueWindow.
 */
export function getQueueWindow(
  queueLen: number,
  focusIdx: number | null = null,
): QueueWindow {
  const start =
    focusIdx === null
      ? 0
      : Math.max(
          0,
          Math.min(focusIdx - 1, Math.max(0, queueLen - QUEUE_WINDOW)),
        );
  const end = Math.min(queueLen, start + QUEUE_WINDOW);
  return { start, end, showLead: start > 0, showTail: end < queueLen };
}

/**
 * The editable text of a queued message: its text parts joined, attachments
 * excluded (they ride along in `parts` and cannot be edited as text). Used by
 * the strip's "edit" action to pull a queued message back into the composer.
 */
export function editableTextOf(parts: readonly SteerPart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("\n\n");
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

/**
 * Take just the OLDEST queued message as the next turn, leaving the rest
 * queued.
 *
 * Queued tasks are processed one at a time, each as its own turn — the Claude
 * queue model the user asked for: type several while the agent works and it
 * works through them in order, one after another, instead of merging them into
 * one giant turn. The composer re-runs this each time a run settles, so the next
 * queued task starts on its own. Null when nothing is queued.
 */
export function flushOne(
  queue: SteerQueue,
): { parts: SteerPart[]; next: SteerQueue } | null {
  if (queue.pending.length === 0) return null;
  const [first, ...rest] = queue.pending;
  return { parts: [...first.parts], next: { pending: rest } };
}

/**
 * What submitting should do right now.
 *
 * Two statuses reach this and they are NOT interchangeable:
 *
 * - `sdkStatus` is the Chat's own status. It reports what is actually running,
 *   and it is the only honest evidence that a run is in flight.
 * - `appStatus` is `agentMeta.status`. It is usually derived from the SDK status
 *   by AgentRunBridge, but the recovery paths (auto-continue, transient retry,
 *   overflow, rejected tool_choice, verify nudge, manual resume) write
 *   "thinking" into it optimistically BEFORE they send. Reading that back would
 *   classify the recovery's own prompt as something typed during a run, queue
 *   it, and then never flush the queue because no run ever started - a permanent
 *   silent stall. That was measured in the field: four and a half hours of no
 *   activity, every Telegram message queued, the app reporting "thinking", and
 *   only `/stop` (which flushes with the busy check bypassed) breaking it.
 *
 * So a RECOVERY prompt is judged by the SDK status alone. An ordinary user
 * message keeps using the app status as well, because after an error the SDK
 * status can lag (still "submitted") while nothing is running, and queueing
 * there is harmless whereas dropping the message is not.
 */
export function submissionAction(args: {
  appStatus: string;
  sdkStatus: string;
  isRecovery: boolean;
  hasContent: boolean;
}): "ignore" | "send" | "queue" {
  const { appStatus, sdkStatus, isRecovery, hasContent } = args;
  if (!hasContent) return "ignore";
  // The SDK status is the truth about a live run, and a recovery must not be
  // held back by a status the recovery itself just invented.
  if (isRecovery) return isBusy(sdkStatus) ? "queue" : "send";
  return isBusy(appStatus) ? "queue" : "send";
}

/**
 * Whether a queued-task flush must wait instead of delivering.
 *
 * The same liveness rule as `submissionAction`, applied to the flush path: while a
 * round is in flight, sending the queued task would race the SDK's own
 * auto-continue into the next tool round — two concurrent requests appending
 * to one transcript, which doubles it every cycle until compaction and the
 * provider's body cap both give out. Null (no live chat) means nothing is in
 * flight, so the flush may proceed.
 */
export function flushShouldHold(status: string | null): boolean {
  return status !== null && isBusy(status);
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

/**
 * Whether a send is the continuation prompt the resume paths inject (Continue,
 * overflow auto-retry, reconnect auto-resume) rather than a fresh user task.
 * A resume keeps the session's todo list — it is the same task; a new task
 * replaces it, so a list abandoned mid-plan does not sit on top of the chat
 * after the user has moved on.
 */
export function isResumeParts(parts: readonly SteerPart[]): boolean {
  if (parts.length !== 1) return false;
  const [first] = parts;
  return first?.type === "text" && first.text === RESUME_PROMPT;
}
