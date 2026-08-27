import { create } from "zustand";

/**
 * Live in-memory status of spawned sub-agents, so a fan-out can be watched as it
 * happens. Written straight from the tool `execute` via `getState()`. No
 * persistence, no React, and crucially NO imports from `../lib` or `../tools`,
 * so wiring it into `tools/subagent.ts` cannot create a cycle. Ported from TEDI.
 */
export type SubagentRunStatus = "running" | "done" | "error";

export type SubagentRun = {
  id: string;
  sessionId: string;
  /** Sub-agent type id (a roster id: explore, code-review, pentest, ...). */
  type: string;
  /** Optional human label from the spawning tool's `description`. */
  label?: string;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  stepCount?: number;
  /** Latest activity label while running (e.g. "grep", "read_file"). */
  currentStep?: string;
  durationMs?: number;
  error?: string;
  /** Final summary text once done, so the live view can show each sub-agent's
   *  result the moment it finishes - without waiting for the whole fan-out. */
  summary?: string;
};

const MAX_RUNS_PER_SESSION = 24;

let seq = 0;

type SubagentRunState = {
  bySession: Record<string, SubagentRun[]>;
  start: (sessionId: string, info: { type: string; label?: string }) => string;
  finish: (
    sessionId: string,
    id: string,
    patch: { stepCount?: number; durationMs?: number; summary?: string },
  ) => void;
  fail: (sessionId: string, id: string, error: string) => void;
  step: (sessionId: string, id: string, patch: { currentStep: string; stepCount: number }) => void;
  clearSession: (sessionId: string) => void;
};

function patchRun(
  s: SubagentRunState,
  sessionId: string,
  id: string,
  patch: Partial<SubagentRun>,
): Partial<SubagentRunState> {
  const list = s.bySession[sessionId];
  if (!list) return {};
  return {
    bySession: {
      ...s.bySession,
      [sessionId]: list.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    },
  };
}

export const useSubagentRunStore = create<SubagentRunState>((set) => ({
  bySession: {},

  start(sessionId, info) {
    const id = `sa-${++seq}`;
    set((s) => {
      const list = s.bySession[sessionId] ?? [];
      const run: SubagentRun = {
        id,
        sessionId,
        type: info.type,
        label: info.label,
        status: "running",
        startedAt: Date.now(),
      };
      const appended = [...list, run];
      let next = appended;
      if (appended.length > MAX_RUNS_PER_SESSION) {
        // Evict oldest FINISHED runs first so a running row is never dropped
        // before its finish()/fail() lands.
        let over = appended.length - MAX_RUNS_PER_SESSION;
        next = appended.filter((r) => {
          if (over > 0 && r.status !== "running") {
            over -= 1;
            return false;
          }
          return true;
        });
        if (next.length > MAX_RUNS_PER_SESSION) {
          next = next.slice(next.length - MAX_RUNS_PER_SESSION);
        }
      }
      return { bySession: { ...s.bySession, [sessionId]: next } };
    });
    return id;
  },

  finish(sessionId, id, patch) {
    set((s) => patchRun(s, sessionId, id, { status: "done", endedAt: Date.now(), ...patch }));
  },

  fail(sessionId, id, error) {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list) return {};
      const endedAt = Date.now();
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: list.map((r) =>
            r.id === id
              ? { ...r, status: "error", endedAt, durationMs: endedAt - r.startedAt, error }
              : r,
          ),
        },
      };
    });
  },

  step(sessionId, id, patch) {
    set((s) => patchRun(s, sessionId, id, patch));
  },

  clearSession(sessionId) {
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));
