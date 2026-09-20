/**
 * Worktree isolation for subagents.
 *
 * Parallel subagents otherwise edit ONE directory. Two writers in one working
 * tree means whichever runs second can read the first's half-finished file, and
 * a failure leaves the workspace in a state neither of them intended. This gives
 * each writing subagent its own git worktree, so their work is independent until
 * it is deliberately brought back.
 *
 * Opt-in for a single writer on purpose. Turning it on by default there would
 * change where an existing subagent writes, and the failure mode of getting
 * that wrong - work landing in a directory nobody looks at - is worse than the
 * collision it prevents. The caller asks for it; nothing here decides to isolate
 * on its own. The one defaulted case is a BATCH with two or more writers, where
 * the collision is certain rather than hypothetical: `defaultBatchIsolation`
 * says when, and `run_subagents` is the caller that acts on it.
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
  worktreeDeleteBranchCommand,
  worktreeRemoveCommand,
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
 * Whether a batch of subagents should isolate when the caller gave no explicit
 * choice.
 *
 * Zero or one writer stays opt-in: a lone subagent writing in the shared tree is
 * the long-standing behaviour, and auto-isolating it would strand its work in a
 * worktree the caller never asked for. Two or more writers is where the
 * collision this module exists to prevent becomes certain - both branch from the
 * same baseline and the later write wins - so it defaults on. Pure, so the
 * threshold is asserted directly.
 */
export function defaultBatchIsolation(writingTaskCount: number): boolean {
  return writingTaskCount >= 2;
}

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
/**
 * Extract the fatal or error line from git output, avoiding progress markers
 * like "Preparing worktree..." that git emits to stderr first.
 */
export function extractGitErrorDetail(stderr: string): string {
  const lines = (stderr || "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    lines.find((l) => /^fatal:|^error:/i.test(l)) ??
    lines.find((l) => !/^preparing worktree/i.test(l)) ??
    lines[lines.length - 1] ??
    ""
  );
}

let isolationMutex: Promise<unknown> = Promise.resolve();

export function createIsolatedWorktree(args: {
  ctx: ToolContext;
  /** Names the branch and directory, so a leftover one is identifiable. */
  label: string;
}): Promise<IsolationCreated | IsolationRefused> {
  const run = () => executeCreateIsolatedWorktree(args);
  const next = isolationMutex.then(run, run);
  isolationMutex = next;
  return next;
}

async function executeCreateIsolatedWorktree(args: {
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

    // 300s, not 120s: `git worktree add` checks out the WHOLE tree, and a large
    // repo (or one bloated by an accidental commit - this repo once carried a
    // 325 MB `.cargo/registry`, 24,620 files, committed by autoCheckpoint) can
    // take minutes on a cold filesystem cache. At 120s every isolated subagent
    // in the field fell back to "NOT isolated" with `git worktree add failed
    // (timed out)` (log 2026-09-20 13:01-13:09), silently defeating the
    // isolation feature. The failure path below cleans up the partial worktree,
    // so a longer budget is safe.
    const result = await native.shellSessionRun(shellId, command, root, 300);
    if (result.exit_code !== 0) {
      const detail = extractGitErrorDetail(result.stderr);
      try {
        await native.shellSessionRun(
          shellId,
          worktreeRemoveCommand(worktreePath),
          root,
          30,
        );
        await native.shellSessionRun(
          shellId,
          worktreeDeleteBranchCommand(info.branchName),
          root,
          30,
        );
      } catch {
        // cleanup failure is ignored
      }
      const exitDesc = result.timed_out
        ? "timed out"
        : `exit ${result.exit_code}`;
      return {
        ok: false,
        reason: `git worktree add failed (${exitDesc})${detail ? `: ${detail}` : ""}`,
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
    return {
      ok: true,
      worktreePath,
      sandboxId: info.id,
      branchName: info.branchName,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
