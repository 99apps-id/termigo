import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";

/**
 * Live in-memory status of spawned sub-agents, so a fan-out can be watched as it
 * happens. Written straight from the tool `execute` via `getState()`. Persisted
 * to disk so completed runs survive a restart and can be inspected later; the
 * live "running" rows are restored as their last-known state. Crucially NO
 * imports from `../lib` or `../tools`, so wiring it into `tools/subagent.ts`
 * cannot create a cycle. Ported from TEDI.
 */
export type SubagentRunStatus = "running" | "done" | "error";

const STORE_PATH = "termigo-subagent-runs.json";
const KEY_RUNS = "runs";
const subagentStore = new LazyStore(STORE_PATH, {
  defaults: {},
  autoSave: 200,
});

// Debounced persistence: `step` fires on every tool call, so writing straight
// through would round-trip JSON per step. Only a settled state (or a clear)
// flushes promptly; an active run is persisted at most every few seconds.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hydratePromise: Promise<void> | null = null;

function scheduleSave(bySession: Record<string, SubagentRun[]>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void subagentStore.set(KEY_RUNS, bySession).catch(() => {});
  }, 300);
}

/**
 * Load persisted subagent runs into the store once. Resolves immediately when
 * already loaded (or when there is nothing on disk). Safe to call repeatedly.
 */
export function ensureSubagentRunsHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const raw =
        await subagentStore.get<Record<string, SubagentRun[]>>(KEY_RUNS);
      if (raw && typeof raw === "object") {
        useSubagentRunStore.setState({ bySession: raw });
      }
    } catch {
      // No file yet, or the store plugin is unavailable (tests / non-Tauri):
      // the in-memory store is a perfectly good fallback.
    }
  })();
  return hydratePromise;
}

// Warm the disk copy at module load so reads (e.g. a restored chat) see prior
// runs without waiting for the first spawn. Fire-and-forget.
void ensureSubagentRunsHydrated();

export type SubagentRun = {
  id: string;
  sessionId: string;
  /** Sub-agent type id (a roster id: explore, code-review, pentest, ...). */
  type: string;
  /** Optional human label from the spawning tool's `description`. */
  label?: string;
  /** Nesting depth (0 = spawned by the main agent, 1 = by another subagent). */
  depth?: number;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  stepCount?: number;
  /** Latest activity label while running (e.g. "grep", "read_file"). */
  currentStep?: string;
  /** Ordered activity labels for the run, so the subagent's work can be
   *  inspected (the "Open Subagent" affordance). */
  steps?: string[];
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
  start: (
    sessionId: string,
    info: { type: string; label?: string; depth?: number },
  ) => string;
  finish: (
    sessionId: string,
    id: string,
    patch: { stepCount?: number; durationMs?: number; summary?: string },
  ) => void;
  fail: (sessionId: string, id: string, error: string) => void;
  step: (
    sessionId: string,
    id: string,
    patch: { currentStep: string; stepCount: number },
  ) => void;
  clearSession: (sessionId: string) => void;
};

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
        depth: info.depth,
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
      const bySession = { ...s.bySession, [sessionId]: next };
      scheduleSave(bySession);
      return { bySession };
    });
    return id;
  },

  finish(sessionId, id, patch) {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list) return {};
      const bySession: Record<string, SubagentRun[]> = {
        ...s.bySession,
        [sessionId]: list.map((r) =>
          r.id === id
            ? { ...r, status: "done", endedAt: Date.now(), ...patch }
            : r,
        ) as SubagentRun[],
      };
      scheduleSave(bySession);
      return { bySession };
    });
  },

  fail(sessionId, id, error) {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list) return {};
      const endedAt = Date.now();
      const bySession: Record<string, SubagentRun[]> = {
        ...s.bySession,
        [sessionId]: list.map((r) =>
          r.id === id
            ? {
                ...r,
                status: "error",
                endedAt,
                durationMs: endedAt - r.startedAt,
                error,
              }
            : r,
        ) as SubagentRun[],
      };
      scheduleSave(bySession);
      return { bySession };
    });
  },

  step(sessionId, id, patch) {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list) return {};
      const run = list.find((r) => r.id === id);
      if (!run) return {};
      const steps = run.steps ?? [];
      // Keep the inspection list bounded; a long subagent shouldn't grow it
      // without limit.
      const nextSteps =
        steps.length >= 200 ? steps : [...steps, patch.currentStep];
      const bySession: Record<string, SubagentRun[]> = {
        ...s.bySession,
        [sessionId]: list.map((r) =>
          r.id === id ? { ...r, ...patch, steps: nextSteps } : r,
        ) as SubagentRun[],
      };
      scheduleSave(bySession);
      return { bySession };
    });
  },

  clearSession(sessionId) {
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      scheduleSave(next);
      return { bySession: next };
    });
  },
}));
