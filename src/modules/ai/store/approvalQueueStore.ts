import { create } from "zustand";
import {
  newApprovalId,
  type PendingApproval,
} from "../lib/approvalQueue";

/**
 * Resolvers for the calls currently blocked, kept outside the store.
 *
 * Zustand state is snapshotted and compared; a promise resolver is neither
 * serialisable nor comparable, and putting one in state makes every consumer
 * re-render on a value it can never use.
 */
const waiting = new Map<string, (approved: boolean) => void>();

type ApprovalQueueState = {
  pending: PendingApproval[];
  /** Block until the user answers. Resolves false if denied or cancelled. */
  request: (
    req: Omit<PendingApproval, "id" | "requestedAt">,
    abortSignal?: AbortSignal,
  ) => Promise<boolean>;
  respond: (ids: readonly string[], approved: boolean) => number;
  /** Deny everything outstanding - what Stop means for blocked work. */
  cancelAll: () => number;
};

export const useApprovalQueue = create<ApprovalQueueState>((set, get) => ({
  pending: [],

  request(req, abortSignal) {
    // Already stopped before it even asked.
    if (abortSignal?.aborted) return Promise.resolve(false);

    const entry: PendingApproval = {
      ...req,
      id: newApprovalId(),
      requestedAt: Date.now(),
    };

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean) => {
        if (settled) return;
        settled = true;
        waiting.delete(entry.id);
        set((s) => ({ pending: s.pending.filter((p) => p.id !== entry.id) }));
        resolve(approved);
      };

      waiting.set(entry.id, settle);
      set((s) => ({ pending: [...s.pending, entry] }));

      // Stop has to reach work that is blocked, not just work that is running.
      // Without this a denied-by-stop call would hold its sub-agent open until
      // the app closed.
      abortSignal?.addEventListener("abort", () => settle(false), {
        once: true,
      });
    });
  },

  respond(ids, approved) {
    let n = 0;
    for (const id of ids) {
      const settle = waiting.get(id);
      if (!settle) continue;
      settle(approved);
      n += 1;
    }
    return n;
  },

  cancelAll() {
    return get().respond(
      get().pending.map((p) => p.id),
      false,
    );
  },
}));

/** Read the queue outside React. */
export function pendingApprovals(): PendingApproval[] {
  return useApprovalQueue.getState().pending;
}
