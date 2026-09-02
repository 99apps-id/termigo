import type { ModelMessage } from "ai";

const KEEP_TAIL = 24;
const ELISION_TEXT =
  "[elided to save context — see prior tool call in history]";

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

/** Serialized size of one message. `approxBytes` summed these; measuring the
 *  WHOLE transcript on every trim step is O(N^2) and froze a large session for
 *  minutes (see compactModelMessagesDetailed), so callers size each message
 *  once and keep a running total instead. */
function messageBytes(m: ModelMessage): number {
  if (typeof m.content === "string") return m.content.length;
  if (!Array.isArray(m.content)) return 0;
  let n = 0;
  for (const part of m.content as ToolPart[]) {
    if (part.type === "text" && typeof part.text === "string")
      n += (part.text as string).length;
    else if (part.type === "tool-result")
      n += JSON.stringify(part.output ?? "").length;
    else if (part.type === "tool-call")
      n += JSON.stringify(part.input ?? "").length;
    else n += 64;
  }
  return n;
}

/** Shrink the string payloads of a tool-call input — a `write_file`'s content,
 *  an `edit`'s old/new strings. A call whose result has already been elided is
 *  dead weight just like the result, and a transcript that builds many files
 *  (an app scaffold) is dominated by these payloads, which the result-only
 *  passes never touched — so a request kept arriving over the provider's body
 *  size cap. Keeps the part's type/toolCallId/toolName, so the tool-call/result
 *  pairing the provider validates is untouched; only oversized string fields
 *  are truncated. */
function shrinkToolCallInput(
  part: ToolPart,
  keepChars: number,
): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-call") return { changed: false, part };
  const input = part.input;
  if (!input || typeof input !== "object") return { changed: false, part };
  const obj = input as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > keepChars) {
      next[k] = `${v.slice(0, keepChars)}\n${ELISION_TEXT}`;
      changed = true;
    } else {
      next[k] = v;
    }
  }
  if (!changed) return { changed: false, part };
  return { changed: true, part: { ...part, input: next } };
}

// Characters per token. Deliberately LOW (a real tokenizer produces more tokens
// than english-prose's ~4-per-token on the dense code, JSON, and base64 that
// fills an agent transcript). Undercounting is what let a request estimated at
// "0.69 × limit" arrive as a real 0.99 × limit and overflow, so we bias the
// estimate upward by dividing by a smaller number.
//
// 2.6 (not the old 3.5): the provider's own reported token counts in prod ran
// ~1.5× our estimate on tool-heavy transcripts, so a request the compactor
// judged "plenty of room" still arrived over the window after a few rounds.
// A more conservative estimate only compacts a little earlier — the safe
// direction — and is what stops a short-but-dense transcript from overflowing.
const CHARS_PER_TOKEN = 2.6;

/** Rough upward-biased token estimate for a run of characters. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Truncate an over-long text part, leaving a marker so the model knows why. */
function truncateTextPart(part: ToolPart, keepChars: number): ToolPart {
  const text = part.text;
  if (typeof text !== "string" || text.length <= keepChars) return part;
  return {
    ...part,
    text: `${text.slice(0, keepChars)}\n${ELISION_TEXT}`,
  };
}

function elideToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value: ELISION_TEXT, __elided: true },
    },
  };
}

function pathOfInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function collectMutationPaths(messages: ModelMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      const name = part.toolName;
      if (
        name === "edit" ||
        name === "multi_edit" ||
        name === "write_file" ||
        name === "create_directory"
      ) {
        const p = pathOfInput(part.input);
        if (p) paths.add(p);
      }
    }
  }
  return paths;
}

function collectLastReadIdxPerPath(
  messages: ModelMessage[],
): Map<string, number> {
  const lastIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      if (p) lastIdx.set(p, i);
    }
  }
  return lastIdx;
}

function dropSupersededReads(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const mutated = collectMutationPaths(messages);
  const lastReadIdx = collectLastReadIdxPerPath(messages);

  const callIdxToPath = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      const id = part.toolCallId;
      if (p && typeof id === "string") callIdxToPath.set(id, p);
    }
  }

  let touched = false;
  const out = messages.map((m, i): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let local = false;
    const nextContent = (m.content as ToolPart[]).map((part) => {
      if (part.type !== "tool-result") return part;
      const id = part.toolCallId;
      if (typeof id !== "string") return part;
      const path = callIdxToPath.get(id);
      if (!path) return part;
      const isStale =
        mutated.has(path) ||
        (lastReadIdx.has(path) && (lastReadIdx.get(path) as number) > i);
      if (!isStale) return part;
      const r = elideToolResult(part);
      if (r.changed) local = true;
      return r.part;
    });
    if (!local) return m;
    touched = true;
    return { ...m, content: nextContent } as ModelMessage;
  });
  return { out, touched };
}

export type CompactResult = {
  messages: ModelMessage[];
  compacted: boolean;
  droppedCount: number;
};

export function compactModelMessages(
  messages: ModelMessage[],
  contextLimit: number,
): ModelMessage[] {
  return compactModelMessagesDetailed(messages, contextLimit).messages;
}

/** Text longer than this in a pre-tail message is truncated by the hard pass. */
const HARD_TEXT_KEEP_CHARS = 600;

/** The final hard cap keeps only this many trailing messages fully intact when
 *  even the tail must be trimmed to fit the window. */
const KEEP_MIN_TAIL = 2;

export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
  reservedTokens = 0,
): CompactResult {
  // The messages are only PART of the request: the system prompt, the tool
  // schemas, and the room the model needs to answer all count against the same
  // window. `reservedTokens` carves those out so compaction targets what is
  // actually left for the transcript, never the raw model limit. Floor at 30%
  // so a huge reserve can never drive the budget to zero.
  const budget = Math.max(
    contextLimit - reservedTokens,
    Math.floor(contextLimit * 0.3),
  );

  let dropped = 0;
  let working = messages;
  // Running byte total. The previous code re-measured the WHOLE transcript
  // (JSON.stringify over every message) inside each trim step's break check —
  // O(N^2) in transcript size, which froze a 959-message session for eight
  // minutes between "runAgentStream: enter" and the model call. Sizes are
  // measured once per message and updated by delta on every rewrite instead.
  let sizes = working.map(messageBytes);
  let totalBytes = sizes.reduce((a, b) => a + b, 0);
  let approxTokens = estimateTokens(totalBytes);

  if (approxTokens >= 0.5 * budget) {
    const r = dropSupersededReads(working);
    if (r.touched) {
      working = r.out;
      dropped++;
      sizes = working.map(messageBytes);
      totalBytes = sizes.reduce((a, b) => a + b, 0);
      approxTokens = estimateTokens(totalBytes);
    }
  }

  if (approxTokens < 0.6 * budget) {
    return {
      messages: working,
      compacted: dropped > 0,
      droppedCount: dropped,
    };
  }

  // Rewrite message i and fold its new size into the running total.
  const replaceAt = (i: number, m: ModelMessage): void => {
    const nb = messageBytes(m);
    totalBytes += nb - sizes[i];
    sizes[i] = nb;
    approxTokens = estimateTokens(totalBytes);
    out[i] = m;
  };

  // Aggressive pass 1: elide every tool result before the tail. Tool outputs
  // (file bodies, command output) are the bulk of a long transcript and the
  // safest thing to drop — the tool call itself stays, so the structure the
  // provider validates is untouched. A pre-tail call's INPUT is shrunk in the
  // same breath: a `write_file` argument carries the whole file body, and
  // leaving it while eliding its result keeps the wire payload almost as large
  // — which is how a "compacted" transcript still arrived over the provider's
  // request-body size cap (HTTP 413).
  const out = working.slice();
  const stopIdx = Math.max(0, out.length - KEEP_TAIL);
  for (let i = 0; i < stopIdx; i++) {
    if (out[i].role === "system") continue;
    if (!Array.isArray(out[i].content)) continue;
    let local = false;
    const next = (out[i].content as ToolPart[]).map((part) => {
      const r = elideToolResult(part);
      if (r.changed) {
        local = true;
        return r.part;
      }
      const s = shrinkToolCallInput(part, HARD_TEXT_KEEP_CHARS);
      if (s.changed) {
        local = true;
        return s.part;
      }
      return part;
    });
    if (local) {
      replaceAt(i, { ...out[i], content: next } as ModelMessage);
      dropped++;
      if (approxTokens < 0.45 * budget) break;
    }
  }

  // Aggressive pass 2 (hard cap): if eliding tool results was not enough — a
  // transcript dominated by huge text parts (a giant paste, long model prose) —
  // truncate the over-long text of pre-tail messages too. Text parts keep the
  // message shape, so this also never breaks tool-call/result pairing.
  if (approxTokens >= 0.6 * budget) {
    for (let i = 0; i < stopIdx; i++) {
      if (out[i].role === "system") continue;
      if (!Array.isArray(out[i].content)) continue;
      let local = false;
      const next = (out[i].content as ToolPart[]).map((part) => {
        if (part.type !== "text") return part;
        const t = truncateTextPart(part, HARD_TEXT_KEEP_CHARS);
        if (t !== part) local = true;
        return t;
      });
      if (local) {
        replaceAt(i, { ...out[i], content: next } as ModelMessage);
        dropped++;
        if (approxTokens < 0.5 * budget) break;
      }
    }
  }

  // Final hard cap: if the transcript STILL exceeds the budget, the bulk is in
  // the tail we normally protect (a run of huge tool outputs — a brute-force
  // sweep, a giant scan). Break into the tail too, keeping only the last few
  // messages intact, so the request cannot exceed the window even when our
  // estimate ran low on dense content. This is the floor that makes an
  // overflow retry actually fit.
  if (approxTokens >= budget) {
    const hardStop = Math.max(0, out.length - KEEP_MIN_TAIL);
    for (let i = 0; i < hardStop; i++) {
      if (out[i].role === "system") continue;
      if (!Array.isArray(out[i].content)) continue;
      let local = false;
      const next = (out[i].content as ToolPart[]).map((part) => {
        const r = elideToolResult(part);
        if (r.changed) {
          local = true;
          return r.part;
        }
        if (part.type === "text") {
          const t = truncateTextPart(part, HARD_TEXT_KEEP_CHARS);
          if (t !== part) {
            local = true;
            return t;
          }
        }
        const s = shrinkToolCallInput(part, HARD_TEXT_KEEP_CHARS);
        if (s.changed) {
          local = true;
          return s.part;
        }
        return part;
      });
      if (local) {
        replaceAt(i, { ...out[i], content: next } as ModelMessage);
        dropped++;
        if (approxTokens < 0.8 * budget) break;
      }
    }
  }

  // Absolute floor: the transcript STILL exceeds the budget. This happens when
  // a single message we protected above is itself larger than the window — one
  // giant tool result in the tail, or a huge string-content paste anywhere that
  // the earlier array-only passes never touched. Left alone, no budget
  // reduction can ever make the request fit, so every overflow retry fails
  // again — the loop the user hits. Trim EVERYTHING (tail included, both
  // content shapes); eliding a tool result or truncating text keeps each
  // message's role and tool-call pairing intact, so the request is always
  // brought under the window even if the last turn ends up heavily elided.
  if (approxTokens >= budget) {
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.role === "system") continue;
      // Only force-trim a message that ALONE meets or exceeds the whole budget:
      // it can never fit beside anything else, so it must be cut wherever it
      // sits, tail included. Smaller messages are left to the passes above so
      // their choices (e.g. keeping the latest file read intact) stand — and a
      // transcript that is merely the sum of many mid-size messages converges
      // instead as the learned budget shrinks on retry.
      if (estimateTokens(sizes[i]) < budget) continue;
      if (typeof m.content === "string") {
        if (m.content.length > HARD_TEXT_KEEP_CHARS) {
          replaceAt(i, {
            ...m,
            content: `${m.content.slice(0, HARD_TEXT_KEEP_CHARS)}\n${ELISION_TEXT}`,
          } as ModelMessage);
          dropped++;
        }
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      let local = false;
      const next = (m.content as ToolPart[]).map((part) => {
        const r = elideToolResult(part);
        if (r.changed) {
          local = true;
          return r.part;
        }
        if (part.type === "text") {
          const t = truncateTextPart(part, HARD_TEXT_KEEP_CHARS);
          if (t !== part) {
            local = true;
            return t;
          }
        }
        const s = shrinkToolCallInput(part, HARD_TEXT_KEEP_CHARS);
        if (s.changed) {
          local = true;
          return s.part;
        }
        return part;
      });
      if (local) {
        replaceAt(i, { ...m, content: next } as ModelMessage);
        dropped++;
      }
    }
  }

  return {
    messages: out,
    compacted: dropped > 0,
    droppedCount: dropped,
  };
}
