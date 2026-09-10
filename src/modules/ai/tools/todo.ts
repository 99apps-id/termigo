import { tool } from "ai";
import { z } from "zod";
import { newTodoId, type Todo, validateTodos } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";
import type { ToolContext } from "./context";

const TodoStatus = z.enum(["pending", "in_progress", "completed"]);

export function buildTodoTools(ctx: ToolContext) {
  return {
    todo_write: tool({
      description:
        "Manage a structured todo list to track major milestones on complex multi-phase tasks. Optional for straightforward coding or refactoring tasks.\n\nWhen to use:\n- Complex multi-phase work with 3+ distinct milestones\n- Multi-module migrations or large features\n\nStates: pending, in_progress, completed. Replaces the previous list with updated statuses.",
      inputSchema: z.object({
        todos: z
          .array(
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
          )
          .describe("The complete list of todos for this task."),
      }),
      execute: async ({ todos }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId)
          return { error: "no active session; cannot persist todos" };

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
  } as const;
}
