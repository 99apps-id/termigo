import { create } from "zustand";

/**
 * In-memory capture of the requests Termigo assembles for the provider.
 *
 * Diagnosing an agent problem meant guessing at what had actually been sent:
 * a provider rejection names a symptom, and the transcript shows what came
 * back, but neither shows the system prompt, the compacted history, or which
 * tools were attached on that particular step. This holds exactly that.
 *
 * Filled only while `debugCaptureEnabled` is on. Never persisted - a capture
 * is the conversation in full, and that belongs in memory for as long as the
 * window is open and nowhere else. It imports nothing from `../lib` or
 * `../tools`, so the agent loop can record into it without a cycle.
 *
 * Keys and auth headers are not part of a snapshot: what is recorded is the
 * request as assembled, before the provider SDK attaches credentials.
 */
export type DebugCapture = {
  id: string;
  /** Epoch ms when captured. */
  at: number;
  model: { id: string; provider: string };
  /** Loop settings for this step - step budget, plan mode, and so on. */
  params: Record<string, unknown>;
  /** The system messages as sent - an array, not a string, because that is the
   *  shape the model receives and a debug view that reshapes its subject is
   *  not much of a debug view. */
  system: unknown;
  /** The messages array handed to the model, after pruning and compaction. */
  messages: unknown;
  tools: { name: string; description?: string }[];
};

/** Enough to see a pattern across a run, few enough to stay bounded. */
const MAX_CAPTURES = 30;
let seq = 0;

type DebugState = {
  /** Newest first. */
  captures: DebugCapture[];
  add: (c: Omit<DebugCapture, "id" | "at">) => void;
  clear: () => void;
};

export const useDebugStore = create<DebugState>((set) => ({
  captures: [],
  add: (c) =>
    set((s) => {
      const entry: DebugCapture = { ...c, id: `dbg-${++seq}`, at: Date.now() };
      const next = [entry, ...s.captures];
      return {
        captures:
          next.length > MAX_CAPTURES ? next.slice(0, MAX_CAPTURES) : next,
      };
    }),
  clear: () => set({ captures: [] }),
}));
