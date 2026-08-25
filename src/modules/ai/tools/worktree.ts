import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { remoteUnsupported } from "../lib/remoteFs";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import type { ToolContext } from "./context";
import {
  generateSandboxInfo,
  registerSandbox,
  getSandbox,
  listSandboxes,
  unregisterSandbox,
  worktreeAddCommand,
  worktreeRemoveCommand,
  worktreeDeleteBranchCommand,
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
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "worktree_create",
            "Use bash_run with `git worktree add` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";

        const info = generateSandboxInfo(task_id);
        const worktreePath = `${cwd.replace(/[\\/]+$/, "")}/${info.subpath}`;
        const command = worktreeAddCommand(worktreePath, info.branchName);

        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };

        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const r = await native.shellSessionRun(shellId, command, cwd, 120);
          if (r.exit_code !== 0) {
            return {
              error: `git worktree add failed (exit ${r.exit_code})`,
              stderr: r.stderr,
              stdout: r.stdout,
            };
          }

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
            worktree_path: worktreePath,
            status: "active",
            note: "Worktree sandbox created. Changes inside this directory do not affect the main branch until merged.",
          };
        } catch (e) {
          return { error: String(e) };
        }
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
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "worktree_discard",
            "Use bash_run with `git worktree remove` on the remote host.",
          );
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const cwd = ctx.getWorkspaceRoot() ?? ctx.getCwd() ?? ".";

        const sandbox = getSandbox(sandbox_id);
        if (!sandbox) {
          return { error: `Sandbox with ID ${sandbox_id} not found.` };
        }

        const removeCommand = worktreeRemoveCommand(sandbox.worktreePath);
        const branchCommand = worktreeDeleteBranchCommand(sandbox.branchName);

        for (const command of [removeCommand, branchCommand]) {
          const safety = checkShellCommand(command);
          if (!safety.ok) return { error: safety.reason };
        }

        try {
          const shellId = await getSessionShell(
            sessionShellKey("git", sid, ctx.getWorkspaceRoot()),
            cwd,
          );
          const removeResult = await native.shellSessionRun(shellId, removeCommand, cwd, 120);
          // Removing the branch is best-effort; the worktree removal is the
          // authoritative cleanup, so a stale branch is not fatal.
          const branchResult = await native.shellSessionRun(shellId, branchCommand, cwd, 60);

          unregisterSandbox(sandbox_id, "discarded");
          return {
            sandbox_id,
            branch: sandbox.branchName,
            status: "discarded",
            worktree_exit_code: removeResult.exit_code,
            branch_exit_code: branchResult.exit_code,
            note: "Worktree sandbox discarded and branch cleaned up.",
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
