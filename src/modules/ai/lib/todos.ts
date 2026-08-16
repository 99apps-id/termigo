import { LazyStore } from "@tauri-apps/plugin-store";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
};

/**
 * A session's list, tagged with the workspace it was written for.
 *
 * The tag exists because a chat session is not tied to a project: switching
 * project keeps the same session, so an untagged list followed the user into
 * the new folder and kept showing tasks about the old one.
 */
export type TodoRecord = {
  workspaceRoot: string | null;
  items: Todo[];
};

export const EMPTY_RECORD: TodoRecord = { workspaceRoot: null, items: [] };

const STORE_PATH = "termigo-ai-todos.json";
const todosKey = (sessionId: string) => `todos:${sessionId}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/**
 * Read a stored value, in either shape.
 *
 * Lists written before the workspace tag existed are bare arrays. They are
 * read with a null root, which shows them in every workspace - the behaviour
 * they already had, rather than making a user's existing lists vanish.
 */
export function parseStoredTodos(raw: unknown): TodoRecord {
  if (Array.isArray(raw)) return { workspaceRoot: null, items: raw as Todo[] };
  if (raw && typeof raw === "object" && Array.isArray((raw as TodoRecord).items)) {
    const rec = raw as TodoRecord;
    return { workspaceRoot: rec.workspaceRoot ?? null, items: rec.items };
  }
  return EMPTY_RECORD;
}

/**
 * Whether a list belongs to the workspace currently open.
 *
 * An untagged list (written before the tag, or with no workspace open) belongs
 * everywhere: it is old data, and hiding it would look like data loss.
 */
export function belongsToWorkspace(
  record: TodoRecord,
  workspaceRoot: string | null,
): boolean {
  if (record.workspaceRoot === null) return true;
  return record.workspaceRoot === workspaceRoot;
}

/** Nothing left to do, so nothing left to show. */
export function isFinished(items: readonly Todo[]): boolean {
  return items.length > 0 && items.every((t) => t.status === "completed");
}

/**
 * Stand down an item that claims to be running once the run has stopped.
 *
 * A stopped run leaves its `in_progress` item saying work is under way, and it
 * says so for good: nothing else ever revisits it. Five such items had been
 * frozen that way in this app's own store. The item goes back to `pending`
 * rather than being deleted or marked done, because that is what is true - it
 * was started and is not finished - and it matches how an interrupted tool
 * call is closed out rather than erased.
 */
export function standDownRunning(items: readonly Todo[]): Todo[] {
  if (!items.some((t) => t.status === "in_progress")) return items as Todo[];
  return items.map((t) =>
    t.status === "in_progress" ? { ...t, status: "pending" as const } : t,
  );
}

export async function loadTodos(sessionId: string): Promise<TodoRecord> {
  return parseStoredTodos(await store.get(todosKey(sessionId)));
}

export async function saveTodos(
  sessionId: string,
  record: TodoRecord,
): Promise<void> {
  await store.set(todosKey(sessionId), record);
}

export async function deleteTodos(sessionId: string): Promise<void> {
  await store.delete(todosKey(sessionId));
}

export function newTodoId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Validate a candidate todo list:
 *  - At most one item with status `in_progress` (anti-drift invariant).
 *  - Titles must be non-empty.
 * Returns null on valid, otherwise an error string.
 */
export function validateTodos(todos: Todo[]): string | null {
  let inProgress = 0;
  for (const t of todos) {
    if (!t.title.trim()) return "todo title cannot be empty";
    if (t.status === "in_progress") inProgress++;
  }
  if (inProgress > 1)
    return `only one todo may be in_progress at a time (got ${inProgress})`;
  return null;
}
