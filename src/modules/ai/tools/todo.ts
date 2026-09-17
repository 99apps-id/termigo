import { tool } from "ai";
import { z } from "zod";
import { newTodoId, type Todo, validateTodos } from "../lib/todos";
import { getTodos, useTodosStore } from "../store/todoStore";
import type { ToolContext } from "./context";

const TodoStatus = z.enum(["pending", "in_progress", "completed"]);

function findTodoIndex(
  todos: readonly Todo[],
  id?: string,
  title?: string,
): number {
  if (id) {
    const idx = todos.findIndex((t) => t.id === id);
    if (idx !== -1) return idx;
  }
  if (title) {
    const trimmed = title.trim();
    if (!trimmed) return -1;
    const lower = trimmed.toLowerCase();
    const exactIdx = todos.findIndex(
      (t) => t.title.trim().toLowerCase() === lower,
    );
    if (exactIdx !== -1) return exactIdx;
    const partialIdx = todos.findIndex((t) => {
      const tLower = t.title.toLowerCase();
      return tLower.includes(lower) || lower.includes(tLower);
    });
    if (partialIdx !== -1) return partialIdx;
  }
  return -1;
}

export function buildTodoTools(ctx: ToolContext) {
  return {
    todo_write: tool({
      description:
        "Manage a structured todo list to track major milestones on complex multi-phase tasks. Optional for straightforward coding or refactoring tasks.\n\nWhen to use:\n- Complex multi-phase work with 3+ distinct milestones\n- Multi-module migrations or large features\n\nStates: pending, in_progress, completed. Replaces the previous list with updated statuses.",
      inputSchema: z.object({
        todos: z
          .union([
            z.array(
              z.object({
                id: z
                  .string()
                  .optional()
                  .describe(
                    "Stable id; generated if omitted. Reuse ids across calls to keep UI stable.",
                  ),
                // Optional and coerced below: some models send only `description`
                // (or `text`) and no `title`. Rejecting the whole call over that
                // was a hard failure on otherwise-valid todos, so accept either.
                title: z.string().optional(),
                description: z.string().optional(),
                text: z.string().optional(),
                status: TodoStatus,
                parent: z
                  .string()
                  .optional()
                  .describe(
                    "Optional id of the parent todo, to nest this item as a subtask. Omit for top-level items.",
                  ),
              }),
            ),
            z.string().describe("JSON-stringified todos array."),
          ])
          .describe("The complete list of todos for this task."),
      }),
      execute: async ({ todos: rawTodos }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId)
          return { error: "no active session; cannot persist todos" };

        let todos: Array<{
          id?: string;
          title?: string;
          description?: string;
          text?: string;
          status: "pending" | "in_progress" | "completed";
          parent?: string;
        }> = [];

        if (typeof rawTodos === "string") {
          try {
            const parsed = JSON.parse(rawTodos);
            if (Array.isArray(parsed)) {
              todos = parsed;
            } else if (parsed && typeof parsed === "object") {
              const obj = parsed as Record<string, unknown>;
              todos = (Array.isArray(obj.todos)
                ? obj.todos
                : Array.isArray(obj.items)
                  ? obj.items
                  : Object.values(obj)) as typeof todos;
            }
          } catch {
            return { error: "Failed to parse todos JSON string" };
          }
        } else if (Array.isArray(rawTodos)) {
          todos = rawTodos;
        }

        const normalized: Todo[] = todos.map((t) => {
          // Prefer an explicit title; fall back to description / text so a model
          // that used the wrong field still produces a usable item.
          const title = (t.title ?? t.description ?? t.text ?? "").trim();
          return {
            id: t.id ?? newTodoId(),
            title: title || "Untitled",
            // Keep a separate description only when it is not the same string we
            // promoted to the title.
            description: t.title ? t.description : undefined,
            status: t.status,
            // Nesting is optional; a dangling parent degrades to root in the
            // renderer (todoTree), so no validation is needed here.
            ...(t.parent ? { parent: t.parent } : {}),
          };
        });

        const err = validateTodos(normalized);
        if (err) return { error: err };

        // Tagged with the project it was written for: the session survives a
        // project switch, and an untagged list followed the user into the new
        // folder still listing the old one's work.
        useTodosStore
          .getState()
          .setTodos(sessionId, normalized, ctx.getWorkspaceRoot());

        return {
          ok: true,
          count: normalized.length,
          inProgress:
            normalized.find((t) => t.status === "in_progress")?.title ?? null,
        };
      },
    }),

    todo_update: tool({
      description:
        "Incrementally update, add, or remove a task in the current session's todo list without rewriting the entire list.\n\nActions:\n- 'update' (default): Update status ('pending', 'in_progress', 'completed'), title, description, or parent of an existing item matched by id or title.\n- 'add': Append a new task to the todo list.\n- 'remove': Remove a task from the todo list by id or title.",
      inputSchema: z.object({
        action: z
          .enum(["update", "add", "remove"])
          .default("update")
          .describe(
            "The action to perform: 'update' (default), 'add', or 'remove'.",
          ),
        id: z
          .string()
          .optional()
          .describe(
            "Id of the todo item to update or remove. If omitted, matches by title.",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Title of the item. Required for 'add'. For 'update' or 'remove', used to find the item if id is not provided.",
          ),
        description: z
          .string()
          .optional()
          .describe("Optional details or description for the item."),
        status: TodoStatus.optional().describe(
          "New status: 'pending', 'in_progress', or 'completed'.",
        ),
        parent: z
          .string()
          .optional()
          .describe("Optional parent todo id for nesting as a subtask."),
        autoCompletePrevious: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "When setting an item to 'in_progress', automatically mark any currently 'in_progress' item as 'completed'. Defaults to true.",
          ),
      }),
      execute: async ({
        action = "update",
        id,
        title,
        description,
        status,
        parent,
        autoCompletePrevious = true,
      }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId)
          return { error: "no active session; cannot persist todos" };

        const workspaceRoot = ctx.getWorkspaceRoot();
        const current = getTodos(sessionId, workspaceRoot);
        let updated = [...current];

        if (action === "add") {
          const taskTitle = (title ?? description ?? "").trim();
          if (!taskTitle)
            return { error: "title is required when adding a todo" };

          const newItem: Todo = {
            id: id ?? newTodoId(),
            title: taskTitle,
            ...(description && description !== taskTitle ? { description } : {}),
            status: status ?? "pending",
            ...(parent ? { parent } : {}),
          };

          if (newItem.status === "in_progress") {
            updated = updated.map((t) =>
              t.status === "in_progress"
                ? {
                    ...t,
                    status: (autoCompletePrevious
                      ? "completed"
                      : "pending") as Todo["status"],
                  }
                : t,
            );
          }

          updated.push(newItem);

          const err = validateTodos(updated);
          if (err) return { error: err };

          useTodosStore.getState().setTodos(sessionId, updated, workspaceRoot);

          return {
            ok: true,
            action,
            count: updated.length,
            inProgress:
              updated.find((t) => t.status === "in_progress")?.title ?? null,
            item: newItem,
            todos: updated,
          };
        }

        if (action === "remove") {
          const targetIdx = findTodoIndex(updated, id, title);
          if (targetIdx === -1) {
            return {
              error: `todo item not found (${id ? `id: ${id}` : `title: "${title}"`})`,
            };
          }
          const removed = updated.splice(targetIdx, 1)[0];

          const err = validateTodos(updated);
          if (err) return { error: err };

          useTodosStore.getState().setTodos(sessionId, updated, workspaceRoot);

          return {
            ok: true,
            action,
            count: updated.length,
            inProgress:
              updated.find((t) => t.status === "in_progress")?.title ?? null,
            removed,
            todos: updated,
          };
        }

        // action === "update"
        const targetIdx = findTodoIndex(updated, id, title);
        if (targetIdx === -1) {
          return {
            error: `todo item not found (${id ? `id: ${id}` : `title: "${title}"`}). Use action: 'add' to create a new item.`,
          };
        }

        const existing = updated[targetIdx];
        const nextStatus = status ?? existing.status;

        if (nextStatus === "in_progress" && existing.status !== "in_progress") {
          updated = updated.map((t, idx) =>
            idx !== targetIdx && t.status === "in_progress"
              ? {
                  ...t,
                  status: (autoCompletePrevious
                    ? "completed"
                    : "pending") as Todo["status"],
                }
              : t,
          );
        }

        const updatedItem: Todo = {
          ...existing,
          ...(title !== undefined && title.trim()
            ? { title: title.trim() }
            : {}),
          ...(description !== undefined ? { description } : {}),
          status: nextStatus,
          ...(parent !== undefined ? { parent } : {}),
        };
        updated[targetIdx] = updatedItem;

        const err = validateTodos(updated);
        if (err) return { error: err };

        useTodosStore.getState().setTodos(sessionId, updated, workspaceRoot);

        return {
          ok: true,
          action,
          count: updated.length,
          inProgress:
            updated.find((t) => t.status === "in_progress")?.title ?? null,
          item: updatedItem,
          todos: updated,
        };
      },
    }),

    todo_read: tool({
      description:
        "Read the current session's todo list and progress.\n\nReturns the list of items, their IDs, statuses, and which item is currently in progress.",
      inputSchema: z.object({
        status: TodoStatus.optional().describe(
          "Optional status filter: 'pending', 'in_progress', or 'completed'. Omit to read all todos.",
        ),
      }),
      execute: async ({ status }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId)
          return { error: "no active session; cannot read todos" };

        const workspaceRoot = ctx.getWorkspaceRoot();
        const all = getTodos(sessionId, workspaceRoot);
        const filtered = status ? all.filter((t) => t.status === status) : all;

        return {
          ok: true,
          count: filtered.length,
          total: all.length,
          inProgress:
            all.find((t) => t.status === "in_progress")?.title ?? null,
          todos: filtered,
        };
      },
    }),
  } as const;
}
