import type { UIMessage } from "ai";
import { RESUME_PROMPT } from "./steer";
import { VERIFY_NUDGE_PREFIX } from "./verifyOnStop";

/** One user turn pinned to the git snapshot taken before its run. */
export type TurnCheckpoint = {
  messageId: string;
  sha: string;
  label: string;
  at: number;
};

/** Human label cap: a chip, not a paragraph. */
export const TURN_LABEL_MAX = 60;

/** First meaningful line of a user turn, for the rewind affordance. */
export function turnLabelFor(text: string): string | null {
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return null;
  return first.length > TURN_LABEL_MAX
    ? `${first.slice(0, TURN_LABEL_MAX - 1)}…`
    : first;
}

function userTextOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function hasFileParts(message: UIMessage): boolean {
  return message.parts.some((p) => p.type === "file");
}

/**
 * Index the snapshot just taken for a turn, or null when there is nothing to
 * point rewind at: no user turn, a synthetic continuation (resume / verify
 * nudge) rather than a fresh task, or a turn with no text and no attachments.
 */
export function turnCheckpointInfo(
  messages: readonly UIMessage[],
  sha: string,
  at: number = Date.now(),
): TurnCheckpoint | null {
  if (!sha) return null;
  let last: UIMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      last = m;
      break;
    }
  }
  if (!last) return null;
  const text = userTextOf(last).trim();
  if (text === RESUME_PROMPT) return null;
  if (text.startsWith(VERIFY_NUDGE_PREFIX)) return null;
  const label = turnLabelFor(text) ?? (hasFileParts(last) ? "attachments" : null);
  if (!label) return null;
  return { messageId: last.id, sha, label, at };
}
