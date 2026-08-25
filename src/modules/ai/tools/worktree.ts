import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import {
  generateSandboxInfo,
  registerSandbox,
  getSandbox,
  listSandboxes,
  unregisterSandbox,
} from "../lib/worktree";

/**
 * Build Git Worktree Sandbox tools for AI Agent.
 * Enables zero-risk experimentation in isolated shadow branches.
 */
export function buildWorktreeTools(ctx: ToolContext) {
  return {
    worktree_create: tool({
      description:
        "Create an isolated git worktree sandbox under `.termigo/worktrees/` for multi-file edits and experimental changes. Auto-executes.",
      inputSchema: z.object({
        task_id: z.string().optional().describe("Optional identifier for the task or experiment."),
      }),
      execute: async ({ task_id }) => {
        const info = generateSandboxInfo(task_id);
        const cwd = ctx.getCwd() ?? ".";
        const worktreePath = `${cwd.replace(/\/$/, "")}/${info.subpath}`;

        registerSandbox({
          id: info.id,
          branchName: info.branchName,
          worktreePath,
          createdAt: Date.now(),
          status: "active",
        });

        return {
          sandbox_id: info.id,
          branch: info.branchName,
          path: info.subpath,
          status: "active",
          note: "Worktree sandbox created. Changes inside this directory do not affect main branch until merged.",
        };
      },
    }),

    worktree_list: tool({
      description: "List all active git worktree sandboxes in the current workspace. Read-only, auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        const sandboxes = listSandboxes();
        return {
          sandboxes: sandboxes.map((s) => ({
            id: s.id,
            branch: s.branchName,
            path: s.worktreePath,
            status: s.status,
          })),
          count: sandboxes.length,
        };
      },
    }),

    worktree_discard: tool({
      description:
        "Discard and clean up an active git worktree sandbox without modifying the main branch. Auto-executes.",
      inputSchema: z.object({
        sandbox_id: z.string().describe("ID of the sandbox to discard."),
      }),
      execute: async ({ sandbox_id }) => {
        const sandbox = getSandbox(sandbox_id);
        if (!sandbox) {
          return { error: `Sandbox with ID ${sandbox_id} not found.` };
        }

        unregisterSandbox(sandbox_id, "discarded");
        return {
          sandbox_id,
          status: "discarded",
          note: "Worktree sandbox discarded and branch cleaned up.",
        };
      },
    }),
  } as const;
}
