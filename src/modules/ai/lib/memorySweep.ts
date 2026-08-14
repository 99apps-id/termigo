// End-of-session memory sweep.
//
// The `remember` tool captures facts the model thought to record mid-run. This
// catches what it did not: when a session is left behind, the transcript is
// summarised once and any durable facts are appended to .termigo/memory.md.
//
// It is deliberately conservative. A sweep costs a model call and writes
// without anyone reading the result, so it only runs when there is enough
// conversation to be worth summarising, and only in the approval modes where
// the user has already delegated workspace writes. In "Ask every time" the
// explicit tool remains the only way in, because a silent background write is
// exactly what that mode says no to.

import { generateText, type LanguageModel, type UIMessage } from "ai";
import type { ApprovalMode } from "./approvalPolicy";
import { rememberFact } from "./memory";

/** Below this the session is a one-off question, not a source of facts. */
export const MIN_MESSAGES_TO_SWEEP = 6;

/** One sweep cannot flood memory, however talkative the model is. */
export const MAX_FACTS_PER_SWEEP = 5;

/** Enough transcript to be useful without re-sending an entire long session. */
const MAX_TRANSCRIPT_CHARS = 12_000;

const PROMPT = [
  "Read this transcript and list facts about the PROJECT that will still be",
  "true in a week and would save time in a future session.",
  "",
  "Include: build/test/deploy commands, conventions the user corrected, tools",
  "they use or refuse, architectural decisions, paths that matter, things that",
  "must never be run.",
  "",
  "Exclude: what happened in this session, the task itself, anything the user",
  "did not confirm, anything you inferred but did not verify, file contents",
  "that can be read again, and anything about you.",
  "",
  "Write each fact as one standalone sentence that makes sense with no",
  "conversation around it. One per line, no bullets, no numbering, no preamble.",
  `At most ${MAX_FACTS_PER_SWEEP}. If nothing qualifies, reply with exactly: NONE`,
].join("\n");

export function shouldSweep(
  messages: readonly UIMessage[],
  mode: ApprovalMode,
): boolean {
  if (mode === "ask") return false;
  return messages.length >= MIN_MESSAGES_TO_SWEEP;
}

/** Flatten a transcript to plain text, keeping the tail if it is long. */
export function transcriptText(messages: readonly UIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.parts
      .filter((p) => (p as { type?: string }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join(" ")
      .trim();
    if (text) lines.push(`${message.role}: ${text}`);
  }
  const joined = lines.join("\n");
  return joined.length > MAX_TRANSCRIPT_CHARS
    ? joined.slice(-MAX_TRANSCRIPT_CHARS)
    : joined;
}

/** Split the model's reply into candidate facts. */
export function parseFacts(reply: string): string[] {
  const trimmed = reply.trim();
  if (!trimmed || /^NONE$/im.test(trimmed)) return [];
  return trimmed
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^NONE$/i.test(line))
    .slice(0, MAX_FACTS_PER_SWEEP);
}

export type SweepDeps = {
  model: LanguageModel;
  workspaceRoot: string | null;
  messages: readonly UIMessage[];
  mode: ApprovalMode;
};

/** Returns the facts actually stored. Never throws: this runs in the background. */
export async function sweepSessionMemory(deps: SweepDeps): Promise<string[]> {
  if (!deps.workspaceRoot) return [];
  if (!shouldSweep(deps.messages, deps.mode)) return [];

  const transcript = transcriptText(deps.messages);
  if (!transcript.trim()) return [];

  let reply: string;
  try {
    const result = await generateText({
      model: deps.model,
      system: PROMPT,
      prompt: transcript,
    });
    reply = result.text;
  } catch {
    return []; // a failed sweep must never surface as a user-facing error
  }

  const stored: string[] = [];
  for (const fact of parseFacts(reply)) {
    try {
      const outcome = await rememberFact(deps.workspaceRoot, fact);
      if (outcome.stored) stored.push(fact);
    } catch {
      // Keep going: one bad fact should not abandon the rest.
    }
  }
  return stored;
}
