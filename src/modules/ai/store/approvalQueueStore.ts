import { create } from "zustand";
import {
  newApprovalId,
  type PendingApproval,
} from "../lib/approvalQueue";

/**
 * How the user answered a single approval request.
 *
 * `approve` and `deny` are the one-shot answers. `allow-session` lets this
 * tool through for the rest of the session without asking again, and
 * `allow-always` persists that choice across sessions. Both of the "allow"
 * answers also approve the request that is currently waiting.
 */
export type ApprovalDecision =
  | "approve"
  | "allow-session"
  | "allow-always"
  | "deny";

/** True when the decision approves the call (as opposed to denying it). */
export function isApprovedDecision(d: ApprovalDecision): boolean {
  return d !== "deny";
}

const MAX_APPROVAL_AGE_MS = 30 * 60 * 1000;

function cleanStaleApprovalsNow(): PendingApproval[] {
  const cutoff = Date.now() - MAX_APPROVAL_AGE_MS;
  const current = useApprovalQueue.getState().pending;
  const stale = current.filter((p) => p.requestedAt < cutoff);
  if (stale.length === 0) return [];
  useApprovalQueue.setState((s) => ({
    pending: s.pending.filter((p) => p.requestedAt >= cutoff),
  }));
  for (const p of stale) {
    const settle = waiting.get(p.id);
    if (settle) settle("deny");
    waiting.delete(p.id);
  }
  return stale;
}

/** Clean stale approvals: older than 30 minutes are auto-denied on startup. */
export async function cleanupStaleApprovals(): Promise<number> {
  return cleanStaleApprovalsNow().length;
}

/**
 * Session-scoped memory of tools the user has allowed.
 *
 * Kept outside the store for the same reason as `waiting`: it is a plain
 * lookup, not UI state, and no component should re-render when it changes.
 * A fresh process starts empty, which is exactly what "this session" means.
 */
const sessionAllowed = new Set<string>();

export function isSessionAllowed(toolName: string): boolean {
  return sessionAllowed.has(toolName);
}

export function rememberSessionAllowed(toolName: string): void {
  sessionAllowed.add(toolName);
}

export function clearSessionAllowed(): void {
  sessionAllowed.clear();
}

/**
 * Resolvers for the calls currently blocked, kept outside the store.
 *
 * Zustand state is snapshotted and compared; a promise resolver is neither
 * serialisable nor comparable, and putting one in state makes every consumer
 * re-render on a value it can never use.
 */
const waiting = new Map<string, (decision: ApprovalDecision) => void>();

type ApprovalQueueState = {
  pending: PendingApproval[];
  /** Block until the user answers. Resolves "deny" if denied or cancelled. */
  request: (
    req: Omit<PendingApproval, "id" | "requestedAt">,
    abortSignal?: AbortSignal,
  ) => Promise<ApprovalDecision>;
  /** Boolean-compatible answer: true approves once, false denies. */
  respond: (ids: readonly string[], approved: boolean) => number;
  /** Answer with a full decision, including the session/always allowances. */
  respondWith: (ids: readonly string[], decision: ApprovalDecision) => number;
  /** Deny everything outstanding - what Stop means for blocked work. */
  cancelAll: () => number;
};

export const useApprovalQueue = create<ApprovalQueueState>((set, get) => ({
  pending: [],

  request(req, abortSignal) {
    // Already stopped before it even asked.
    if (abortSignal?.aborted) return Promise.resolve("deny");

    const entry: PendingApproval = {
      ...req,
      id: newApprovalId(),
      requestedAt: Date.now(),
    };

    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        waiting.delete(entry.id);
        set((s) => ({ pending: s.pending.filter((p) => p.id !== entry.id) }));
        resolve(decision);
      };

      // Auto-expire stale approvals so they cannot hang the bot forever.
      const ttlMs = 5 * 60 * 1000;
      const expiryTimer = setTimeout(() => {
        if (!settled) {
          settle("deny");
          console.warn(
            `[ai] approval auto-expired after ${ttlMs}ms id=${entry.id} tool=${entry.toolName}`,
          );
        }
      }, ttlMs);

      const cancelExpiry = () => clearTimeout(expiryTimer);

      waiting.set(entry.id, settle);
      set((s) => ({ pending: [...s.pending, entry] }));

      // Stop has to reach work that is blocked, not just work that is running.
      // Without this a denied-by-stop call would hold its sub-agent open until
      // the app closed.
      abortSignal?.addEventListener("abort", () => {
        cancelExpiry();
        settle("deny");
      }, { once: true });
    });
  },

  respond(ids, approved) {
    return get().respondWith(ids, approved ? "approve" : "deny");
  },

  respondWith(ids, decision) {
    let n = 0;
    for (const id of ids) {
      const settle = waiting.get(id);
      if (!settle) continue;
      settle(decision);
      n += 1;
    }
    return n;
  },

  cancelAll() {
    return get().respondWith(
      get().pending.map((p) => p.id),
      "deny",
    );
  },
}));

/** Read the queue outside React. */
export function pendingApprovals(): PendingApproval[] {
  return useApprovalQueue.getState().pending;
}
