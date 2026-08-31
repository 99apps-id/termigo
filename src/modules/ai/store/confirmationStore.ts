import { create } from "zustand";

/**
 * Pending "keep or revert this mutation?" confirmations, surfaced as a
 * clickable card in the chat (BatikCode `ToolCallStatus.PendingResultConfirmation`
 * / `chatToolPostExecuteConfirmationPart` parity). After a mutating tool runs
 * successfully, its wrapper registers a confirmation here and awaits the
 * user's decision; the UI renders Keep / Revert buttons and calls `resolve`.
 * `cancel` / abort resolves the await with null (the change is kept — an
 * aborted run must never auto-revert).
 */
export type PendingConfirmation = {
  id: string;
  sessionId: string;
  toolName: string;
  summary: string;
  touchedPaths: string[];
  /** Resolves the awaiting tool execute with true (keep) / false (revert). */
  resolve: (keep: boolean | null) => void;
};

type ConfirmationState = {
  pending: PendingConfirmation[];
  /**
   * Register a confirmation and wait for the user's decision. `abortSignal`
   * (from the tool invocation) cancels the wait with null when the run is
   * stopped — the change is kept, never silently reverted.
   */
  request: (
    sessionId: string,
    info: {
      toolName: string;
      summary: string;
      touchedPaths: string[];
    },
    abortSignal?: AbortSignal,
  ) => Promise<boolean | null>;
  /** The user clicked Keep (true) or Revert (false) — resolve and drop. */
  resolve: (id: string, keep: boolean) => void;
  /** Dismiss without a decision (resolve null → change kept). */
  cancel: (id: string) => void;
};

let seq = 0;

export const useConfirmationStore = create<ConfirmationState>((set, get) => ({
  pending: [],

  request(sessionId, info, abortSignal) {
    return new Promise<boolean | null>((resolve) => {
      const id = `confirm-${++seq}`;
      set((s) => ({
        pending: [...s.pending, { id, sessionId, ...info, resolve }],
      }));
      const cancel = () => {
        const item = get().pending.find((p) => p.id === id);
        if (!item) return;
        item.resolve(null);
        set((s) => ({
          pending: s.pending.filter((p) => p.id !== id),
        }));
      };
      if (abortSignal) {
        if (abortSignal.aborted) {
          queueMicrotask(cancel);
        } else {
          abortSignal.addEventListener("abort", cancel, { once: true });
        }
      }
    });
  },

  resolve(id, keep) {
    const item = get().pending.find((p) => p.id === id);
    if (!item) return;
    item.resolve(keep);
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },

  cancel(id) {
    const item = get().pending.find((p) => p.id === id);
    if (!item) return;
    item.resolve(null);
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },
}));
