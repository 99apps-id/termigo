import type { UIMessage } from "ai";

/**
 * Split a transcript at a user message for edit and resend.
 *
 * Returns the messages before the target plus the target itself, or null when
 * the target is missing or is not a user message. The caller drops everything
 * from the target onward and sends the edited text as a fresh turn, so a
 * correction restarts the run from that point instead of piling on after it.
 */
export function splitForEdit(
  messages: readonly UIMessage[],
  targetId: string,
): { prefix: UIMessage[]; target: UIMessage } | null {
  const idx = messages.findIndex((m) => m.id === targetId);
  if (idx < 0) return null;
  const target = messages[idx];
  if (target?.role !== "user") return null;
  return { prefix: messages.slice(0, idx), target };
}
