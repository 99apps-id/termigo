/**
 * Worktree isolation for subagents.
 *
 * Parallel subagents otherwise edit ONE directory. Two writers in one working
 * tree means whichever runs second can read the first's half-finished file, and
 * a failure leaves the workspace in a state neither of them intended. This gives
 * each writing subagent its own git worktree, so their work is independent until
 * it is deliberately brought back.
 *
 * Opt-in on purpose. Turning it on by default would change where every existing
 * subagent writes, and the failure mode of getting that wrong - work landing in a
 * directory nobody looks at - is worse than the collision it prevents. The caller
 * asks for it; nothing here decides to isolate on its own.
 *
 * Read-only subagents are never isolated: they do not write, so a worktree would
 * only give them a copy to read stale content from.
 */

import type { ToolContext } from "../tools/context";
import { native } from "./native";
import { checkShellCommand } from "./security";
import { getSessionShell, sessionShellKey } from "./sessionShell";
import {
  generateSandboxInfo,
  registerSandbox,
  worktreeAddCommand,
} from "./worktree";

export type IsolationInput = {
  /** The caller asked for isolation. */
  requested: boolean;
  /** The subagent's own definition declares it read-only. */
  isReadOnly: boolean;
  /** The active terminal is an SSH leaf, so the files live on another host. */
  hasRemoteSession: boolean;
  /** Explorer root to create the worktree under. */
  workspaceRoot: string | null;
};

export type IsolationPlan =
  | { isolate: true }
  | { isolate: false; reason: string };

/**
 * Whether this subagent should get its own worktree.
 *
 * Pure: the reasons are the interesting part, and a test can assert each one.
 * Whether the workspace is actually a git repository is deliberately NOT checked
 * here - the caller attempts the worktree and falls back if git refuses, which
 * covers that case (and an unreadable repo) with one code path instead of a
 * separate probe that could disagree with it.
 */
export function planSubagentIsolation(input: IsolationInput): IsolationPlan {
  if (!input.requested) {
    return { isolate: false, reason: "not requested" };
  }
  if (input.isReadOnly) {
    return {
      isolate: false,
      reason: "read-only subagent: a worktree would only be a stale copy",
    };
  }
  if (input.hasRemoteSession) {
    return {
      isolate: false,
      reason: "remote session: a local worktree would not contain the work",
    };
  }
  if (!input.workspaceRoot) {
    return { isolate: false, reason: "no workspace root" };
  }
  return { isolate: true };
}

/**
 * A ToolContext that reads and writes inside `dir` instead of the workspace.
 *
 * Only the filesystem roots move. Everything else - the terminal, the browser,
 * the control plane - still refers to the one running app, because the subagent
 * is the same process in the same session; it is the FILES that are isolated.
 *
 * Pointing `getWorkspaceRoot` at the worktree also confines the path checks: a
 * write resolved against it cannot escape back into the main tree, which is what
 * makes the isolation hold rather than merely suggest.
 */
export function rerootToolContext(ctx: ToolContext, dir: string): ToolContext {
  return {
    ...ctx,
    getCwd: () => dir,
    getWorkspaceRoot: () => dir,
  };
}

/** Where a subagent's isolated worktree lives, relative to the workspace root. */
export function worktreeRelativePath(sandboxId: string): string {
  return `.termigo/worktrees/${sandboxId}`;
}

export type IsolationCreated = {
  ok: true;
  worktreePath: string;
  sandboxId: string;
  branchName: string;
};

export type IsolationRefused = { ok: false; reason: string };

/**
 * Create the worktree an isolated subagent will work in.
 *
 * Reuses the exact sequence the `worktree_create` tool already uses - same
 * `checkShellCommand` guard, same session shell, same `git worktree add` builder -
 * so this adds a caller, not a second implementation that could drift from the
 * one already in use.
 *
 * NEVER throws and never aborts the run. Every failure returns a reason and the
 * caller carries on in the shared workspace: a subagent that runs unisolated is
 * the behaviour that existed before this feature, so degrading to it is safe,
 * whereas failing the task because a branch could not be created is not.
 *
 * Deliberately does NOT clean up. The worktree and its branch are registered so
 * `worktree_list` shows them and `worktree_discard` can remove them, but nothing
 * here deletes a directory that may hold the subagent's only copy of its work.
 */
export async function createIsolatedWorktree(args: {
  ctx: ToolContext;
  /** Names the branch and directory, so a leftover one is identifiable. */
  label: string;
}): Promise<IsolationCreated | IsolationRefused> {
  const { ctx, label } = args;
  const sessionId = ctx.getSessionId();
  if (!sessionId) return { ok: false, reason: "no active chat session" };
  const root = ctx.getWorkspaceRoot();
  if (!root) return { ok: false, reason: "no workspace root" };

  const info = generateSandboxInfo(label);
  const worktreePath = `${root.replace(/[\\/]+$/, "")}/${worktreeRelativePath(info.id)}`;
  const command = worktreeAddCommand(worktreePath, info.branchName);

  const safety = checkShellCommand(command);
  if (!safety.ok) return { ok: false, reason: safety.reason };

  try {
    const shellId = await getSessionShell(
      sessionShellKey("git", sessionId, root),
      root,
    );
    const result = await native.shellSessionRun(shellId, command, root, 120);
    if (result.exit_code !== 0) {
      // The message carries git's own stderr: "not a git repository" and a
      // permission failure need different responses, and both arrive here.
      const detail = (result.stderr || "").trim().split("\n")[0] ?? "";
      return {
        ok: false,
        reason: `git worktree add failed (exit ${result.exit_code})${detail ? `: ${detail}` : ""}`,
      };
    }
    registerSandbox({
      id: info.id,
      branchName: info.branchName,
      worktreePath,
      createdAt: Date.now(),
      status: "active",
      description: `isolated subagent: ${label}`,
    });
    return { ok: true, worktreePath, sandboxId: info.id, branchName: info.branchName };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

