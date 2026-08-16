// Approvals for work that cannot use the SDK's approval protocol.
//
// The main agent's approvals ride the message round-trip: `streamText` emits a
// `tool-approval-request`, the run ends, the UI answers, and the next request
// carries the response. A sub-agent cannot do that. It runs headless inside
// `generateText`, which is itself called from inside a tool call on the main
// run, so there is no message boundary to suspend at and nothing to resume.
//
// It does not need one. A tool's `execute` is ordinary async code in the same
// JavaScript runtime as the UI, so it can simply await a promise the user
// resolves. That is all this is: a queue of pending requests, each holding the
// resolver for the call that is blocked on it.
//
// The queue is deliberately explicit about who is asking. With four builders
// running at once, "approve" with no target is a question, not an answer.

export type PendingApproval = {
  id: string;
  /** Who is asking - "explore #2", "builder #1". Shown in the queue. */
  requester: string;
  toolName: string;
  /** Short human-readable summary of what it wants to do. */
  summary: string;
  requestedAt: number;
};

export type ApprovalTarget =
  | { kind: "all" }
  | { kind: "index"; index: number }
  | { kind: "only" };

/**
 * Parse the argument of `/approve` or `/deny`.
 *
 * Bare means "the only one", not "the first one": with several queued, a bare
 * command is ambiguous and answering the wrong agent is not recoverable by
 * retyping. `parseTarget` says what was asked; the caller decides if it fits.
 */
export function parseApprovalTarget(arg: string): ApprovalTarget | null {
  const t = arg.trim().toLowerCase();
  if (t === "") return { kind: "only" };
  if (t === "all" || t === "semua") return { kind: "all" };
  if (/^\d+$/.test(t)) {
    const index = Number.parseInt(t, 10);
    return index >= 1 ? { kind: "index", index } : null;
  }
  return null;
}

/** Which queued ids a target selects, or an error saying why none. */
export function resolveTarget(
  pending: readonly PendingApproval[],
  target: ApprovalTarget,
): { ids: string[] } | { error: string } {
  if (pending.length === 0) return { error: "nothing is waiting for approval" };
  switch (target.kind) {
    case "all":
      return { ids: pending.map((p) => p.id) };
    case "index": {
      const entry = pending[target.index - 1];
      if (!entry) {
        return {
          error: `there is no #${target.index}; ${pending.length} waiting`,
        };
      }
      return { ids: [entry.id] };
    }
    case "only": {
      if (pending.length > 1) {
        return {
          error: `${pending.length} are waiting - say which, or "all"`,
        };
      }
      return { ids: [pending[0].id] };
    }
  }
}

/** One line per entry, numbered the way the command addresses them. */
export function formatQueue(pending: readonly PendingApproval[]): string {
  if (pending.length === 0) return "nothing is waiting for approval";
  return pending
    .map((p, i) => `${i + 1}. ${p.requester} - ${p.toolName}: ${p.summary}`)
    .join("\n");
}

let seq = 0;
export function newApprovalId(): string {
  seq += 1;
  return `q-${Date.now().toString(36)}-${seq}`;
}

/**
 * A one-line gist of a tool's input, for the queue listing.
 *
 * The queue is read in a terminal-sized strip while several agents wait, so a
 * pretty-printed object is worse than useless. The fields checked first are the
 * ones that identify the action: what command, which file.
 */
export function summarizeInput(input: unknown): string {
  if (typeof input === "string") return truncate(input);
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "url", "query"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return truncate(v);
  }
  return truncate(Object.keys(o).join(", "));
}

function truncate(s: string, max = 80): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
