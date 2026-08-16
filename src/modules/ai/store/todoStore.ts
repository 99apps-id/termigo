import { create } from "zustand";
import {
  belongsToWorkspace,
  deleteTodos as persistDelete,
  EMPTY_RECORD,
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
