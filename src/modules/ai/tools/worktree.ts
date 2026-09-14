import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import { remoteUnsupported } from "../lib/remoteFs";
import { getSessionShell, sessionShellKey } from "../lib/sessionShell";
import type { ToolContext } from "./context";
import {
  discoveredWorktrees,
  generateSandboxInfo,
  getSandbox,
  listSandboxes,
  registerSandbox,
  unregisterSandbox,
  worktreeAddCommand,
  worktreeRemoveCommand,
  worktreeDeleteBranchCommand,
} from "../lib/worktree";

/**
 * Sandboxes that exist on disk but were not created by this process.
 *
 * Non-throwing on purpose. It runs inside `worktree_list`, which is read-only and
 * must keep working when the workspace is not a repo, the git command fails, or
 * the control plane is busy - an error there would turn "what worktrees do I
 * have?" into a failure instead of a shorter list.
 */
async function discoverSandboxes(
  ctx: ToolContext,
): Promise<ReturnType<typeof discoveredWorktrees>> {
  const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
  if (!root) return [];
  try {
    const { branches } = await native.gitListBranches(root);
    const known = new Set(listSandboxes().map((s) => s.id));
    return discoveredWorktrees(branches).filter((d) => !known.has(d.id));
  } catch {
    return [];
  }
}

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
      description:
        "List all git worktree sandboxes in the current workspace, including any left behind by a previous app run. Read-only, auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        const sandboxes = listSandboxes();
        // Git is the authority on what exists; the registry is only what THIS
        // process created. Merging the two is what makes a sandbox from a
        // previous run visible at all - see `discoveredWorktrees`.
        const orphans = await discoverSandboxes(ctx);
        return {
          sandboxes: [
            ...sandboxes.map((s) => ({
              id: s.id,
              branch: s.branchName,
              path: s.worktreePath,
              status: s.status,
            })),
            ...orphans.map((o) => ({
              id: o.id,
              branch: o.branchName,
              path: o.worktreePath,
              // Not "active": nothing in this process is using it. Named so the
              // agent can tell it apart from a sandbox it just created, and so
              // discarding it is an informed choice rather than a guess.
              status: "orphaned" as const,
              note: "From a previous run. Its work is still on disk; worktree_discard removes it.",
            })),
          ],
          count: sandboxes.length + orphans.length,
          ...(orphans.length > 0 ? { orphaned: orphans.length } : {}),
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
        // A sandbox from a previous run is not in the registry, so fall back to
        // what git reports. Without this, the orphans that `worktree_list` now
        // shows could be listed but never removed - visible and still stuck.
        const discovered = sandbox
          ? undefined
          : (await discoverSandboxes(ctx)).find((d) => d.id === sandbox_id);
        if (!sandbox && !discovered) {
          return { error: `Sandbox with ID ${sandbox_id} not found.` };
        }
        const target = sandbox ?? {
          worktreePath: discovered?.worktreePath ?? "",
          branchName: discovered?.branchName ?? "",
        };

        const removeCommand = worktreeRemoveCommand(target.worktreePath);
        const branchCommand = worktreeDeleteBranchCommand(target.branchName);

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
            branch: target.branchName,
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
