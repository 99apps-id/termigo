import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";

/** A recurring task the agent is asked to keep in mind for this session. */
export type SessionSchedule = {
  id: string;
  /** Human description of when it fires (e.g. "daily at 09:00", "every morning"). */
  when: string;
  /** The task the agent should run. */
  prompt: string;
  enabled: boolean;
  /** Recurring interval in ms (e.g. every 30m). Absent for one-off daily tasks. */
  intervalMs?: number;
  /** Daily trigger "HH:MM" in local time. Absent for interval tasks. */
  dailyAt?: string;
  /** Epoch ms of the next fire. Absent for display-only tasks that never auto-run. */
  nextDueAt?: number;
  /** Epoch ms when the task was created. */
  createdAt?: number;
};

/** Optional scheduling spec passed alongside a schedule. */
export type ScheduleSpec = {
  intervalMs?: number;
  dailyAt?: string;
  nextDueAt: number;
};

type Directives = {
  goal: string | null;
  schedules: SessionSchedule[];
  /** The workspace this directive was set for. Null = legacy untagged. */
  workspaceRoot: string | null;
};

type State = {
  /** Directives keyed by session id so switching sessions does not bleed goals. */
  bySession: Record<string, Directives>;
  /** Set of sessionIds whose directives were hydrated from disk. */
  hydrated: Set<string>;
  getGoal: (sessionId: string, workspaceRoot: string | null) => string | null;
  getSchedules: (
    sessionId: string,
    workspaceRoot: string | null,
  ) => SessionSchedule[];
  setGoal: (
    sessionId: string,
    workspaceRoot: string | null,
    goal: string | null,
  ) => void;
  addSchedule: (
    sessionId: string,
    workspaceRoot: string | null,
    when: string,
    prompt: string,
    spec?: ScheduleSpec,
  ) => void;
  removeSchedule: (
    sessionId: string,
    workspaceRoot: string | null,
    id: string,
  ) => void;
  toggleSchedule: (
    sessionId: string,
    workspaceRoot: string | null,
    id: string,
  ) => void;
  /** Bump a schedule's next fire time after it runs. */
  updateScheduleNext: (
    sessionId: string,
    workspaceRoot: string | null,
    id: string,
    nextDueAt: number,
  ) => void;
};

function directivesFor(state: State, sessionId: string): Directives {
  return (
    state.bySession[sessionId] ?? {
      goal: null,
      schedules: [],
      workspaceRoot: null,
    }
  );
}

const STORE_PATH = "termigo-ai-directives.json";
const DIRECTIVES_KEY = (sessionId: string) => `directives:${sessionId}`;

let storeInstance: {
  get: (k: string) => Promise<unknown>;
  set: (k: string, v: unknown) => Promise<void>;
  delete: (k: string) => Promise<boolean>;
} | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = new LazyStore(STORE_PATH, {
      defaults: {},
      autoSave: 200,
    }) as {
      get: (k: string) => Promise<unknown>;
      set: (k: string, v: unknown) => Promise<void>;
      delete: (k: string) => Promise<boolean>;
    };
  }
  return storeInstance;
}

export async function persistLoad(sessionId: string): Promise<Directives> {
  const store = await getStore();
  const raw = await store.get(DIRECTIVES_KEY(sessionId));
  if (!raw) return { goal: null, schedules: [], workspaceRoot: null };
  const obj = raw as Record<string, unknown>;
  const goal =
    typeof obj.goal === "string"
      ? obj.goal
      : typeof obj.goal === "number"
        ? String(obj.goal)
        : null;
  const schedules = Array.isArray(obj.schedules)
    ? (obj.schedules as SessionSchedule[])
    : [];
  const workspaceRoot =
    typeof obj.workspaceRoot === "string" ? obj.workspaceRoot : null;
  return { goal, schedules, workspaceRoot };
}

export async function persistSave(
  sessionId: string,
  directives: Directives,
): Promise<void> {
  const store = await getStore();
  await store.set(DIRECTIVES_KEY(sessionId), directives);
}

export async function persistDelete(sessionId: string): Promise<void> {
  const store = await getStore();
  await store.delete(DIRECTIVES_KEY(sessionId));
}

function belongsToWorkspace(
  recordWorkspaceRoot: string | null,
  workspaceRoot: string | null,
): boolean {
  if (recordWorkspaceRoot === null) return true;
  return recordWorkspaceRoot === workspaceRoot;
}

export const useSessionDirectiveStore = create<State>((set, get) => ({
  bySession: {},
  hydrated: new Set<string>(),

  async hydrate(sessionId: string) {
    if (get().hydrated.has(sessionId)) return;
    const directives = await persistLoad(sessionId);
    set((s) => {
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.add(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: directives },
        hydrated: nextHydrated,
      };
    });
  },

  getGoal: (sessionId, workspaceRoot) => {
    const d = directivesFor(get(), sessionId);
    if (!belongsToWorkspace(d.workspaceRoot, workspaceRoot)) return null;
    return d.goal;
  },

  getSchedules: (sessionId, workspaceRoot) => {
    const d = directivesFor(get(), sessionId);
    if (!belongsToWorkspace(d.workspaceRoot, workspaceRoot)) return [];
    return d.schedules;
  },

  setGoal: (sessionId, workspaceRoot, goal) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...d,
            goal,
            workspaceRoot: d.workspaceRoot ?? workspaceRoot,
          },
        },
      };
    }),

  addSchedule: (sessionId, workspaceRoot, when, prompt, spec) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      const schedule: SessionSchedule = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        when,
        prompt,
        enabled: true,
        intervalMs: spec?.intervalMs,
        dailyAt: spec?.dailyAt,
        nextDueAt: spec?.nextDueAt,
        createdAt: Date.now(),
      };
      const nextDirectives: Directives = {
        ...d,
        schedules: [...d.schedules, schedule],
        workspaceRoot: d.workspaceRoot ?? workspaceRoot,
      };
      void persistSave(sessionId, nextDirectives);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: nextDirectives,
        },
      };
    }),

  removeSchedule: (sessionId, workspaceRoot, id) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      if (!belongsToWorkspace(d.workspaceRoot, workspaceRoot)) return state;
      const nextDirectives: Directives = {
        ...d,
        schedules: d.schedules.filter((s) => s.id !== id),
      };
      void persistDelete(sessionId);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: nextDirectives,
        },
      };
    }),

  toggleSchedule: (sessionId, workspaceRoot, id) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      if (!belongsToWorkspace(d.workspaceRoot, workspaceRoot)) return state;
      const nextDirectives: Directives = {
        ...d,
        schedules: d.schedules.map((s) =>
          s.id === id ? { ...s, enabled: !s.enabled } : s,
        ),
      };
      void persistSave(sessionId, nextDirectives);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: nextDirectives,
        },
      };
    }),

  updateScheduleNext: (sessionId, workspaceRoot, id, nextDueAt) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      if (!belongsToWorkspace(d.workspaceRoot, workspaceRoot)) return state;
      const nextDirectives: Directives = {
        ...d,
        schedules: d.schedules.map((s) =>
          s.id === id ? { ...s, nextDueAt } : s,
        ),
      };
      void persistSave(sessionId, nextDirectives);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: nextDirectives,
        },
      };
    }),
}));
