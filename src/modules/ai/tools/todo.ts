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
        "Manage a structured todo list to track progress and plan tasks throughout the run. Use it VERY frequently to ensure task visibility and proper planning.\n\nWhen to use:\n- Complex multi-step work requiring planning and tracking\n- When the user provides multiple tasks or requests\n- After receiving new instructions that require multiple steps\n- BEFORE starting work on any todo (mark as in_progress)\n- IMMEDIATELY after completing each todo (mark completed individually)\n\nCRITICAL workflow (share this with the user):\n1. Plan tasks by writing a todo list with specific, actionable items\n2. Mark exactly ONE todo as in_progress before starting work\n3. Complete the work for that todo\n4. Mark that todo as completed IMMEDIATELY — do NOT wait until the whole list is finished to check everything off at once, and do NOT batch completions\n5. Move to the next todo and repeat\n\nTodo states:\n- pending: not yet begun\n- in_progress: currently working (limit ONE at a time)\n- completed: finished successfully\n\nThis tool REPLACES the previous list (never a delta), so each call passes the FULL updated list with statuses. Auto-executes (no approval).",
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
