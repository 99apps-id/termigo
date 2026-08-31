import { create } from "zustand";
import {
  belongsToWorkspace,
  EMPTY_RECORD,
  deleteTodos as persistDelete,
  loadTodos as persistLoad,
  saveTodos as persistSave,
  standDownRunning,
  type Todo,
  type TodoRecord,
} from "../lib/todos";

type TodosState = {
  /** Map of sessionId -> the session's list and the workspace it was for. */
  bySession: Record<string, TodoRecord>;
  /** Set of sessionIds whose todos were hydrated. */
  hydrated: Set<string>;
  hydrate: (sessionId: string) => Promise<void>;
  setTodos: (
    sessionId: string,
    todos: Todo[],
    workspaceRoot: string | null,
  ) => void;
  /** Stand down anything still marked running, once a run has stopped. */
  runStopped: (sessionId: string) => void;
  /**
   * Mark the currently `in_progress` item completed. Called when a run settles
   * cleanly, as a fallback for the model forgetting to check the item it was
   * actively working on. Leaves `pending` items alone (those may be unfinished).
   */
  completeInProgress: (sessionId: string) => void;
  /**
   * Mark every item that was started (not `pending`) completed. Called when a
   * run finishes cleanly — the model decided it was done, so any item it began
   * (in_progress, or an earlier one it neglected to check off) is now done.
   * Genuinely-unstarted `pending` items are left alone, because a run may stop
   * before finishing the whole plan; a clean finish with leftover pending items
   * simply means the model judged the remaining work out of scope.
   */
  completeStarted: (sessionId: string) => void;
  clearSession: (sessionId: string) => Promise<void>;
};

export const useTodosStore = create<TodosState>((set, get) => ({
  bySession: {},
  hydrated: new Set(),

  async hydrate(sessionId) {
    if (get().hydrated.has(sessionId)) return;
    const record = await persistLoad(sessionId);
    set((s) => {
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.add(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: record },
        hydrated: nextHydrated,
      };
    });
  },

  setTodos(sessionId, todos, workspaceRoot) {
    const record: TodoRecord = { workspaceRoot, items: todos };
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: record } }));
    void persistSave(sessionId, record);
  },

  runStopped(sessionId) {
    const current = get().bySession[sessionId];
    if (!current) return;
    const items = standDownRunning(current.items);
    // Reference equality means nothing was running, so nothing to write.
    if (items === current.items) return;
    const record: TodoRecord = { ...current, items };
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: record } }));
    void persistSave(sessionId, record);
  },

  completeInProgress(sessionId) {
    const current = get().bySession[sessionId];
    if (!current) return;
    const update = (items: Todo[]) =>
      items.map((t) =>
        t.status === "in_progress" ? { ...t, status: "completed" as const } : t,
      );
    if (!current.items.some((t) => t.status === "in_progress")) return;
    const record: TodoRecord = { ...current, items: update(current.items) };
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: record } }));
    void persistSave(sessionId, record);
  },

  completeStarted(sessionId) {
    const current = get().bySession[sessionId];
    if (!current) return;
    // Only items the agent actually began (in_progress, or one it neglected to
    // check off) are marked done. A genuinely-unstarted `pending` item stays
    // pending: a run may legitimately stop before finishing the whole plan, and
    // marking unstarted work done would lie about it.
    const update = (items: Todo[]) =>
      items.map((t) =>
        t.status === "pending" ? t : { ...t, status: "completed" as const },
      );
    if (!current.items.some((t) => t.status !== "pending")) return;
    const record: TodoRecord = { ...current, items: update(current.items) };
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: record } }));
    void persistSave(sessionId, record);
  },

  async clearSession(sessionId) {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.delete(sessionId);
      return { bySession: next, hydrated: nextHydrated };
    });
    await persistDelete(sessionId);
  },
}));

export function getTodoRecord(sessionId: string | null): TodoRecord {
  if (!sessionId) return EMPTY_RECORD;
  return useTodosStore.getState().bySession[sessionId] ?? EMPTY_RECORD;
}

/** The list to act on: this session's, and only if it is for this project. */
export function getTodos(
  sessionId: string | null,
  workspaceRoot: string | null = null,
): Todo[] {
  const record = getTodoRecord(sessionId);
  if (!belongsToWorkspace(record, workspaceRoot)) return [];
  return record.items;
}
