import type { ModelMessage } from "ai";

/**
 * Context pruning: replace an early, *verified* span of the transcript with a
 * short checkpoint summary instead of shipping the full chat (file bodies,
 * command output, repeated reads) every turn.
 *
 * Compaction (`compact.ts`) trims the SAME messages by size — eliding tool
 * results, truncating prose — but every message still crosses the wire. That
 * keeps the transcript readable but costs tokens on every turn after the work
 * is done. This module goes further: when a span is *verified* (its mutations
 * are saved to git via a successful `git_checkpoint` / `git_commit`), the whole
 * span is collapsed into a single user message summarising what was changed,
 * read, run and checked. The model keeps knowing the current state without
 * re-paying for the history that produced it.
 *
 * Safety: a prefix is only cut at a point where every tool-call inside has its
 * tool-result inside too (tool-call/result pairing is what providers validate,
 * so we never leave a dangling call or an orphaned result). The tail is always
 * protected so the immediately preceding turns stay fully intact.
 */

const PRUNE_MIN_VERIFIED_MESSAGES = 6;
/** How many trailing messages are always kept intact, verified or not. */
const PRUNE_TAIL_KEEP = 6;
const SUMMARY_MAX_CHARS = 1800;

/** Tool calls whose success proves the surrounding work is saved to git. */
const VERIFIED_TOOLS = new Set(["git_checkpoint", "git_commit"]);
const MUTATION_TOOLS = new Set([
  "edit",
  "multi_edit",
  "write_file",
  "create_directory",
  "delete_file",
  "move_file",
  "copy_file",
]);
const READ_TOOLS = new Set(["read_file"]);
const COMMAND_TOOLS = new Set(["bash_run", "bash_background"]);
const CHECK_TOOLS = new Set(["run_checks", "lint", "test"]);
const DIFF_TOOLS = new Set(["git_diff"]);

const ELISION = "…";

type Part = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

function partsOf(m: ModelMessage): Part[] {
  return Array.isArray(m.content) ? (m.content as Part[]) : [];
}

/** +1 per tool-call, -1 per tool-result in a message. */
function balanceDelta(m: ModelMessage): number {
  let d = 0;
  for (const part of partsOf(m)) {
    if (part.type === "tool-call") d += 1;
    else if (part.type === "tool-result") d -= 1;
  }
  return d;
}

function inputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function outputText(part: Part): string {
  const out = part.output;
  if (out == null) return "";
  if (typeof out === "string") return out;
  const obj = out as { value?: unknown };
  if (typeof obj.value === "string") return obj.value;
  return JSON.stringify(obj);
}

/**
 * A tool result counts as successful when it carries no `error` key and its
 * `exit_code` (when present) is 0. The exit code can sit directly on the
 * output object or inside the SDK's stringified `value`.
 */
function resultOk(part: Part): boolean {
  const out = part.output;
  if (out == null) return false;
  if (typeof out === "object") {
    const obj = out as {
      error?: unknown;
      ok?: unknown;
      exit_code?: unknown;
      passed?: unknown;
      timed_out?: unknown;
    };
    if (obj.error) return false;
    if (obj.ok === false) return false;
    if (obj.passed === false) return false;
    if (obj.timed_out === true) return false;
    if (typeof obj.exit_code === "number" && obj.exit_code !== 0) return false;
    const raw = JSON.stringify(out);
    const exitMatch = /"exit_code"\s*:\s*(-?\d+)/.exec(raw);
    if (exitMatch && exitMatch[1] !== "0") return false;
    return true;
  }
  if (typeof out === "string") {
    const trimmed = out.trim();
    if (/^(error|fatal)[:\s]/i.test(trimmed)) return false;
    const exitMatch = /"exit_code"\s*:\s*(-?\d+)/.exec(trimmed);
    if (exitMatch && exitMatch[1] !== "0") return false;
    return trimmed.length > 0;
  }
  return false;
}

function hasVerifiedSignal(m: ModelMessage): boolean {
  for (const part of partsOf(m)) {
    if (part.type !== "tool-result") continue;
    if (!part.toolName || !VERIFIED_TOOLS.has(part.toolName)) continue;
    if (resultOk(part)) return true;
  }
  return false;
}

/**
 * Find the highest index `c` (in message-count terms) such that the prefix
 * `[0, c)` is self-contained (every tool-call inside has its result inside),
 * contains at least one verified checkpoint/commit, and leaves the tail intact.
 * Returns -1 when no such safe cut exists.
 */
export function findVerifiedCut(messages: ModelMessage[]): number {
  const n = messages.length;
  if (n < PRUNE_MIN_VERIFIED_MESSAGES + PRUNE_TAIL_KEEP) return -1;

  const balance = new Array<number>(n + 1).fill(0);
  const verifiedPrefix = new Array<number>(n + 1).fill(0);
  let b = 0;
  let v = 0;
  for (let i = 0; i < n; i++) {
    b += balanceDelta(messages[i]);
    balance[i + 1] = b;
    if (hasVerifiedSignal(messages[i])) v += 1;
    verifiedPrefix[i + 1] = v;
  }

  const maxCut = n - PRUNE_TAIL_KEEP;
  for (let c = maxCut; c >= PRUNE_MIN_VERIFIED_MESSAGES; c--) {
    if (balance[c] !== 0) continue;
    if (verifiedPrefix[c] === 0) continue;
    return c;
  }
  return -1;
}

export type PruneSummary = {
  checkpoints: string[];
  changed: { path: string; edits: number; writes: number }[];
  read: string[];
  commands: { command: string; ok: boolean }[];
  checks: { command: string; ok: boolean }[];
  diffNotes: string[];
};

export function summarizeSegment(messages: ModelMessage[]): PruneSummary {
  const checkpoints: string[] = [];
  const changed = new Map<string, { edits: number; writes: number }>();
  const read = new Set<string>();
  // Commands and checks are paired by tool-call id so a result reliably
  // updates the right entry (matching on the extracted command string is
  // fragile when the model passes an override like `run_checks {kind}`).
  const commandById = new Map<string, { command: string; ok: boolean }>();
  const checkById = new Map<string, { command: string; ok: boolean }>();
  const diffNotes: string[] = [];

  for (const m of messages) {
    for (const part of partsOf(m)) {
      const name = part.toolName;
      if (!name) continue;

      if (part.type === "tool-call") {
        if (MUTATION_TOOLS.has(name)) {
          const p = inputPath(part.input);
          if (p) {
            const entry = changed.get(p) ?? { edits: 0, writes: 0 };
            if (name === "write_file") entry.writes += 1;
            else entry.edits += 1;
            changed.set(p, entry);
          }
        } else if (READ_TOOLS.has(name)) {
          const p = inputPath(part.input);
          if (p) read.add(p);
        } else if (COMMAND_TOOLS.has(name)) {
          const input = part.input as { command?: unknown } | undefined;
          const cmd = typeof input?.command === "string" ? input.command : "";
          if (cmd && part.toolCallId) {
            commandById.set(part.toolCallId, { command: cmd, ok: true });
          }
        } else if (CHECK_TOOLS.has(name)) {
          const input = part.input as
            | {
                command?: unknown;
                kind?: unknown;
              }
            | undefined;
          const cmd =
            typeof input?.command === "string"
              ? input.command
              : typeof input?.kind === "string"
                ? `run_checks ${input.kind}`
                : name;
          if (part.toolCallId) {
            checkById.set(part.toolCallId, { command: cmd, ok: true });
          }
        }
        continue;
      }

      if (part.type !== "tool-result") continue;
      const ok = resultOk(part);
      const id = part.toolCallId;
      if (VERIFIED_TOOLS.has(name)) {
        checkpoints.push(extractCheckpointLabel(outputText(part)));
      } else if (COMMAND_TOOLS.has(name) && id) {
        const entry = commandById.get(id);
        if (entry) entry.ok = ok;
      } else if (CHECK_TOOLS.has(name) && id) {
        const entry = checkById.get(id);
        if (entry) {
          // The result carries the command that actually ran (e.g. `pnpm
          // test` when the call only said `run_checks {kind:"test"}`) — prefer
          // that over the generic call name in the summary.
          const actual = commandFromOutput(outputText(part));
          if (actual) entry.command = actual;
          entry.ok = ok;
        }
      } else if (DIFF_TOOLS.has(name) && diffNotes.length < 2) {
        const text = outputText(part).trim();
        if (text) diffNotes.push(truncate(text, 400));
      }
    }
  }

  return {
    checkpoints,
    changed: [...changed.entries()]
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    read: [...read].sort(),
    commands: [...commandById.values()].slice(0, 8),
    checks: [...checkById.values()].slice(0, 8),
    diffNotes,
  };
}

function commandFromOutput(text: string): string {
  const m = /"command"\s*:\s*"([^"]+)"/.exec(text);
  return m ? m[1] : "";
}

function extractCheckpointLabel(text: string): string {
  // The output carries `"message":"checkpoint: <label>"` (or a raw message).
  const m = /"message"\s*:\s*"([^"]+)"/.exec(text);
  if (m) return m[1];
  const plain = /checkpoint\s*:\s*([^\s,]+)/.exec(text);
  if (plain) return `checkpoint: ${plain[1]}`;
  return "checkpoint";
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}${ELISION}`;
}

export function formatPruneSummary(summary: PruneSummary): string {
  const lines: string[] = [];

  if (summary.checkpoints.length > 0) {
    lines.push("Saved to git:");
    for (const c of summary.checkpoints.slice(0, 4)) lines.push(`- ${c}`);
    lines.push("");
  }

  if (summary.changed.length > 0) {
    lines.push(`Files changed (${summary.changed.length}):`);
    for (const f of summary.changed.slice(0, 12)) {
      const ops: string[] = [];
      if (f.writes > 0) ops.push(`write${f.writes > 1 ? `×${f.writes}` : ""}`);
      if (f.edits > 0) ops.push(`edit${f.edits > 1 ? `×${f.edits}` : ""}`);
      lines.push(`- ${f.path}${ops.length ? ` (${ops.join(", ")})` : ""}`);
    }
    lines.push("");
  }

  if (summary.read.length > 0) {
    const shown = summary.read.slice(0, 20);
    lines.push(
      `Files read (${summary.read.length}): ${shown.join(", ")}${summary.read.length > shown.length ? `, +${summary.read.length - shown.length} more` : ""}`,
    );
    lines.push("");
  }

  if (summary.commands.length > 0) {
    lines.push("Commands run:");
    for (const c of summary.commands) {
      lines.push(`- ${truncate(c.command, 120)} (exit ${c.ok ? "0" : "≠0"})`);
    }
    lines.push("");
  }

  if (summary.checks.length > 0) {
    lines.push("Checks:");
    for (const c of summary.checks) {
      lines.push(
        `- ${truncate(c.command, 120)} → ${c.ok ? "passed" : "failed"}`,
      );
    }
    lines.push("");
  }

  if (summary.diffNotes.length > 0) {
    lines.push("Diff (compressed):");
    for (const d of summary.diffNotes) lines.push(d);
    lines.push("");
  }

  let text = lines.join("\n").trim();
  if (text.length > SUMMARY_MAX_CHARS) {
    text = truncate(text, SUMMARY_MAX_CHARS);
  }
  return text;
}

export type PruneResult = {
  messages: ModelMessage[];
  pruned: boolean;
  cutAt: number;
  summary: string | null;
};

/**
 * Replace the verified prefix with a single user message carrying the
 * checkpoint summary. Returns the input untouched when no safe cut exists.
 */
export function pruneVerifiedPrefix(messages: ModelMessage[]): PruneResult {
  const cut = findVerifiedCut(messages);
  if (cut <= 0) {
    return { messages, pruned: false, cutAt: -1, summary: null };
  }
  const segment = messages.slice(0, cut);
  const summary = formatPruneSummary(summarizeSegment(segment));
  const head: ModelMessage = {
    role: "user",
    content: `[Earlier context pruned: ${cut} messages summarized below. The work is already saved to git as a checkpoint — continue from the current state without re-doing it.]\n\n${summary}`,
  };
  return {
    messages: [head, ...messages.slice(cut)],
    pruned: true,
    cutAt: cut,
    summary,
  };
}
