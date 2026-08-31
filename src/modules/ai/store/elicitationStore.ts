import { create } from "zustand";

/**
 * Pending "ask the user" questions, surfaced as a clickable chooser in the
 * chat (BatikCode `chatElicitationContentPart` / `chatQuestionCarouselPart`
 * parity). The agent's `ask_user` tool registers a question here and awaits the
 * user's pick; the UI renders the options and calls `answer` with the chosen
 * one. `cancel` resolves the await with null (run aborted / dismissed).
 */
export type PendingElicitation = {
  id: string;
  question: string;
  options: string[];
  /** Resolves the awaiting tool call with the chosen option text (or null). */
  resolve: (answer: string | null) => void;
};

type ElicitationState = {
  pending: PendingElicitation[];
  /**
   * Register a question and wait for an answer. `abortSignal` (from the tool
   * invocation) cancels the wait with null when the run is stopped.
   */
  ask: (
    question: string,
    options: string[],
    abortSignal?: AbortSignal,
  ) => Promise<string | null>;
  /** The user clicked an option — resolve and drop the question. */
  answer: (id: string, answer: string) => void;
  /** Dismiss without an answer (resolve null). */
  cancel: (id: string) => void;
};

let seq = 0;

export const useElicitationStore = create<ElicitationState>((set, get) => ({
  pending: [],

  ask(question, options, abortSignal) {
    return new Promise<string | null>((resolve) => {
      const id = `elicit-${++seq}`;
      set((s) => ({
        pending: [...s.pending, { id, question, options, resolve }],
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
          // The listener stays until the signal fires; after the user answers
          // `cancel` is a no-op, so this only retains a reference per ask.
          abortSignal.addEventListener("abort", cancel, { once: true });
        }
      }
    });
  },

  answer(id, answer) {
    const item = get().pending.find((p) => p.id === id);
    if (!item) return;
    item.resolve(answer);
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },

  cancel(id) {
    const item = get().pending.find((p) => p.id === id);
    if (!item) return;
    item.resolve(null);
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },
}));
