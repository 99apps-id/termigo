import type { UIMessage } from "ai";

/**
 * Whether the run is resuming a tool call the user has just approved.
 *
 * This decides whether the environment turn may be appended, because the SDK
 * finds approvals in exactly one place:
 *
 *     const lastMessage = messages.at(-1);
 *     if (lastMessage?.role != "tool") return { approvedToolApprovals: [] };
 *
 * It also decides whether the initial model-response watchdog (firstStepTimer)
 * should run, because when resuming an approval, step 0 executes the tool
 * locally/remotely before the model is called.
 */
export function isResumingApproval(messages: readonly UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return false;
  const lastStepStartIndex = last.parts.reduce(
    (lastIndex, part: { type?: string }, index) =>
      part.type === "step-start" ? index : lastIndex,
    -1,
  );
  const candidateParts =
    lastStepStartIndex >= 0
      ? last.parts.slice(lastStepStartIndex + 1)
      : last.parts;
  return candidateParts.some(
    (part: unknown) =>
      (part as { state?: string }).state === "approval-responded",
  );
}
