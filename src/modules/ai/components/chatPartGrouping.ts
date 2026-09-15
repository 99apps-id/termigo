import type { UIMessagePart } from "ai";

export type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

export type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string }
  | { kind: "reasoning"; text: string; key: string };

export function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

export function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

export function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

/**
 * Whether the model is thinking *right now*.
 *
 * True only while the message is mid-stream AND the newest part is a reasoning
 * part, because a chunk appends to the end of the message. The moment the model
 * moves on - to a tool call, to prose, to anything - the newest part is no
 * longer reasoning and the thinking is finished.
 *
 * This is what the old rule got wrong. It asked "is the reasoning block the last
 * GROUP?", which in a tool-using run is never true: the parts look like
 * `step-start, reasoning, tool-bash_run, step-start, reasoning, ...`, so a tool
 * card always trails the thinking. The block therefore never auto-opened during
 * a real task and the user could not see the agent think - which is exactly when
 * they need to, because a long silent run is indistinguishable from a loop.
 *
 * Pure, so the rule can be tested without rendering a chat.
 */
export function isThinkingLive(
  parts: readonly AnyPart[],
  streaming: boolean,
): boolean {
  if (!streaming || parts.length === 0) return false;
  return partType(parts[parts.length - 1]) === "reasoning";
}

/** Index of the last reasoning group, or -1. Only that one can be live. */
export function lastReasoningGroupIndex(groups: readonly Group[]): number {
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (groups[i].kind === "reasoning") return i;
  }
  return -1;
}

export function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    const { parts: runParts, startIdx } = run;
    if (runParts.length >= 2) {
      out.push({
        kind: "reads",
        parts: runParts,
        key: `reads-${partKey(runParts[0], startIdx)}`,
      });
    } else {
      runParts.forEach((p, k) => {
        const idx = startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  // One thinking block PER STEP, not one per message.
  //
  // Folding every reasoning part into a single block was tried and reverted: it
  // produced one "Reasoned for Xs" label for a ten-step run, so the block sat at
  // the top of the transcript and grew while the live edge of the work moved
  // further down. The streamed thinking the user is supposed to watch appeared
  // far from the tool card it explains.
  //
  // Per step, the active block is the one that auto-opens (see `isThinkingLive`)
  // and it closes itself when the step ends, so the transcript reads top-to-
  // bottom in the order the agent actually worked. Steps whose thinking is
  // finished collapse to their one-line label, which is what keeps a long run
  // scannable.
  let thinking: { text: string[]; key: string } | null = null;
  const flushThinking = () => {
    if (!thinking) return;
    const step = thinking;
    thinking = null;
    const slot = out.findIndex(
      (g) => g.kind === "reasoning" && g.key === step.key,
    );
    if (slot === -1) return;
    out[slot] = {
      kind: "reasoning",
      // Blank line between the parts of ONE step: that is several passes of
      // thinking, not one paragraph, and running them together reads as a
      // non sequitur.
      text: step.text.join("\n\n"),
      key: step.key,
    };
  };

  parts.forEach((p, i) => {
    if (partType(p) === "reasoning") {
      flushRun();
      if (!thinking) {
        thinking = { text: [], key: `reasoning-${partKey(p, i)}` };
        // Placeholder in position; its text is filled in when the step ends.
        out.push({ kind: "reasoning", text: "", key: thinking.key });
      }
      const text = (p as unknown as { text?: string }).text ?? "";
      if (text) thinking.text.push(text);
      return;
    }
    // Any other part ends this step's thinking.
    flushThinking();
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  flushThinking();
  return out;
}
