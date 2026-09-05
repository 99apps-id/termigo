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
  // Every reasoning part in the message folds into one block, shown where the
  // first one appeared. A multi-step run emits one per step, so a five-step
  // task stacked five "Reasoned for 2s" labels down the transcript and buried
  // the work between them. One label for the whole run reads the way VS Code's
  // does; the thinking itself is all still there, in order, inside it.
  let reasoning: { text: string[]; key: string } | null = null;

  parts.forEach((p, i) => {
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    if (partType(p) === "reasoning") {
      const text = (p as unknown as { text?: string }).text ?? "";
      if (!reasoning) {
        reasoning = { text: [], key: `reasoning-${partKey(p, i)}` };
        // Placeholder in position; its text is filled in as later parts arrive.
        out.push({ kind: "reasoning", text: "", key: reasoning.key });
      }
      if (text) reasoning.text.push(text);
      return;
    }
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();

  if (reasoning) {
    const merged = reasoning as { text: string[]; key: string };
    const slot = out.findIndex(
      (g) => g.kind === "reasoning" && g.key === merged.key,
    );
    if (slot !== -1) {
      out[slot] = {
        kind: "reasoning",
        // Blank line between steps: it is several passes of thinking, not one
        // paragraph, and running them together reads as a non sequitur.
        text: merged.text.join("\n\n"),
        key: merged.key,
      };
    }
  }
  return out;
}
