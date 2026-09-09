import { LazyStore } from "@tauri-apps/plugin-store";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  /** Optional parent id, for nesting subtasks under a bigger item. Dangling
   *  or cyclic parents degrade to root level — nothing is ever hidden. */
  parent?: string;
};

/**
 * DFS order of a (possibly nested) todo list: `[item, depth]` pairs, parents
 * before children. Ported from Hermes' `todoTree()` so both surfaces render
 * the same hierarchy from the same `parent` field.
 *
 * Robust by construction: a `parent` that names a missing item (or the item
 * itself) is treated as a root, and members of a parent cycle — which no DFS
 * from a root can reach — are appended flat at the end so no item is lost.
 */
export function todoTree<T extends { id: string; parent?: string }>(
  todos: readonly T[],
): [T, number][] {
  const ids = new Set(todos.map((t) => t.id));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];

  for (const t of todos) {
    if (t.parent && ids.has(t.parent) && t.parent !== t.id) {
      const list = kids.get(t.parent) ?? [];
      list.push(t);
      kids.set(t.parent, list);
    } else {
      roots.push(t);
    }
  }

  const out: [T, number][] = [];
  const seen = new Set<string>();

  const walk = (item: T, depth: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push([item, depth]);
    for (const kid of kids.get(item.id) ?? []) {
      walk(kid, depth + 1);
    }
  };

  for (const root of roots) {
    walk(root, 0);
  }

  // Cycle members never reach a root — append them flat so nothing is lost.
  for (const t of todos) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      out.push([t, 0]);
    }
  }

  return out;
}

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

/**
 * Render the current todo list as a short, status-tracked block, or null when
 * there is nothing to show. Injected into each agent step's system prompt (and
 * the env block) so the model is reminded of what is done / in progress /
 * pending at every decision point — the way Copilot's per-item checklist works.
 *
 * Nested items are indented under their parent (via `todoTree`) so the model
 * sees the same hierarchy the UI renders. Items without a `parent` render flat,
 * exactly as before.
 */
export function formatTodoStatusBlock(
  items: { id?: string; title: string; status: TodoStatus; parent?: string }[],
): string | null {
  if (items.length === 0) return null;
  // todoTree keys off `id`; callers without ids (legacy shapes) get a stable
  // positional one so nothing collides in the seen-set.
  const withIds = items.map((t, i) => ({ ...t, id: t.id ?? `idx-${i}` }));
  const lines = todoTree(withIds).map(
    ([t, depth]) => `${"  ".repeat(Math.min(depth, 4))}- [${t.status}] ${t.title}`,
  );
  return [
    "Current todo list — keep it accurate: mark each item [completed] the moment you finish it, then set the next [in_progress].",
    ...lines,
  ].join("\n");
}

/**
 * The index of the todo a run is currently working on, for the live HUD.
 *
 * The model is supposed to keep exactly one item `in_progress`, but it often
 * forgets to mark the next item as it moves on (the same gap the auto-check
 * fallback covers on settle). The HUD therefore derives the "active" item: an
 * explicit `in_progress` wins; otherwise the first non-completed item stands in
 * as "up next", so the user always sees which line the current step belongs to.
 * Returns -1 when there is nothing left to do.
 */
export function activeTodoIndex(items: { status: TodoStatus }[]): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i].status === "in_progress") return i;
  }
  for (let i = 0; i < items.length; i++) {
    if (items[i].status === "pending") return i;
  }
  return -1;
}

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
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as TodoRecord).items)
  ) {
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
