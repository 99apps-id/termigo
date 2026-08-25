import { create } from "zustand";

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
};

type State = {
  /** Directives keyed by session id so switching sessions does not bleed goals. */
  bySession: Record<string, Directives>;
  getGoal: (sessionId: string) => string | null;
  getSchedules: (sessionId: string) => SessionSchedule[];
  setGoal: (sessionId: string, goal: string | null) => void;
  addSchedule: (sessionId: string, when: string, prompt: string, spec?: ScheduleSpec) => void;
  removeSchedule: (sessionId: string, id: string) => void;
  toggleSchedule: (sessionId: string, id: string) => void;
  /** Bump a schedule's next fire time after it runs. */
  updateScheduleNext: (sessionId: string, id: string, nextDueAt: number) => void;
};

function directivesFor(state: State, sessionId: string): Directives {
  return state.bySession[sessionId] ?? { goal: null, schedules: [] };
}

export const useSessionDirectiveStore = create<State>((set, get) => ({
  bySession: {},
  getGoal: (sessionId) =>
    directivesFor(get(), sessionId).goal,
  getSchedules: (sessionId) => directivesFor(get(), sessionId).schedules,
  setGoal: (sessionId, goal) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { ...directivesFor(state, sessionId), goal },
      },
    })),
  addSchedule: (sessionId, when, prompt, spec) =>
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
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...d, schedules: [...d.schedules, schedule] },
        },
      };
    }),
  removeSchedule: (sessionId, id) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...d,
            schedules: d.schedules.filter((s) => s.id !== id),
          },
        },
      };
    }),
  toggleSchedule: (sessionId, id) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...d,
            schedules: d.schedules.map((s) =>
              s.id === id ? { ...s, enabled: !s.enabled } : s,
            ),
          },
        },
      };
    }),
  updateScheduleNext: (sessionId, id, nextDueAt) =>
    set((state) => {
      const d = directivesFor(state, sessionId);
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...d,
            schedules: d.schedules.map((s) =>
              s.id === id ? { ...s, nextDueAt } : s,
            ),
          },
        },
      };
    }),
}));
