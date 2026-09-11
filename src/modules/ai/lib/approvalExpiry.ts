// How long an unanswered approval may hold a run.
//
// The AI SDK pauses a run on `approval-requested` and waits for the user. There
// is no deadline of its own, so an approval the user never answers - the card
// scrolled out of view, they closed the laptop, or they tapped the Telegram
// prompt away - left `agentMeta.status` on "awaiting-approval" indefinitely.
// The run was not dead and not failed; it was simply waiting, with nothing on
// screen saying for how long or what would happen if it was ignored.
//
// The approval QUEUE already auto-denies after five minutes
// (`store/approvalQueueStore.ts`), so the same window is used here: one rule
// for both paths rather than two behaviours the user has to learn separately.
//
// Denying is the right expiry. It settles the run so the model sees the refusal
// and can adapt or ask, which is strictly more useful than a pause that never
// ends - and it matches what the queue does, so the two cannot disagree.

/** How long an unanswered approval may block a run. Mirrors the queue's TTL. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** The reason recorded on an expired approval, shown to the user and the model. */
export const APPROVAL_EXPIRED_REASON =
  "No response after 5 minutes - the action was not run. Ask again if you still need it.";

/**
 * Which approvals should now have a timer, and which timers are stale.
 *
 * The effect that drives this re-runs on every streamed token, so the caller
 * must not restart a timer it already holds: a 5-minute countdown that resets
 * on each token would never fire during a long run. Keeping the decision pure
 * makes that testable without a renderer.
 *
 * `pending` is the ids still awaiting an answer; `armed` is the ids already
 * holding a timer.
 */
export function reconcileApprovalTimers(
  armed: ReadonlySet<string>,
  pending: readonly string[],
): { arm: string[]; clear: string[] } {
  const pendingSet = new Set(pending);
  const arm = pending.filter((id) => !armed.has(id));
  // A timer whose approval was answered, denied, or removed with its message is
  // stale; firing it later would respond to an id the run has moved past.
  const clear = [...armed].filter((id) => !pendingSet.has(id));
  return { arm, clear };
}

/** The approval ids still awaiting a response in the newest assistant message. */
export function pendingApprovalIds(messages: readonly unknown[]): string[] {
  const last = messages[messages.length - 1] as
    | { role?: string; parts?: Array<Record<string, unknown>> }
    | undefined;
  if (!last || last.role !== "assistant" || !Array.isArray(last.parts)) {
    return [];
  }
  const ids: string[] = [];
  for (const part of last.parts) {
    if (part.state !== "approval-requested") continue;
    const id = (part.approval as { id?: string } | undefined)?.id;
    if (id) ids.push(id);
  }
  return ids;
}
