/**
 * Git Worktree Isolation Layer (Ephemeral Sandbox)
 *
 * Allows agents to perform risky or large multi-file edits in an isolated
 * git worktree sandbox before applying them to the user's working tree.
 */

import { quoteShellArg } from "@/lib/shellQuote";

export type WorktreeSandbox = {
  id: string;
  branchName: string;
  worktreePath: string;
  createdAt: number;
  status: "active" | "applied" | "discarded" | "merged";
  description?: string;
};

const activeSandboxes = new Map<string, WorktreeSandbox>();

/**
 * Generate a unique task sandbox identifier and branch name.
 */
export function generateSandboxInfo(taskId?: string): {
  id: string;
  branchName: string;
  subpath: string;
} {
  const cleanId = (taskId ?? Math.random().toString(36).slice(2, 9)).replace(/[^a-zA-Z0-9_-]/g, "_");
  const branchName = `termigo-sandbox/${cleanId}`;
  const subpath = `.termigo/worktrees/${cleanId}`;
  return { id: cleanId, branchName, subpath };
}

/**
 * Construct safe git CLI arguments for worktree operations.
 */
export function buildWorktreeCommands(opts: {
  worktreePath: string;
  branchName: string;
}) {
  return {
    add: ["worktree", "add", "-b", opts.branchName, opts.worktreePath, "HEAD"],
    remove: ["worktree", "remove", "--force", opts.worktreePath],
    deleteBranch: ["branch", "-D", opts.branchName],
    list: ["worktree", "list", "--porcelain"],
  };
}

/**
 * Shell command builders (quoted) for executing worktree operations through a
 * session shell. Exported so the constructed shell line is testable.
 */
export function worktreeAddCommand(worktreePath: string, branchName: string): string {
  return `git worktree add -b ${quoteShellArg(branchName)} ${quoteShellArg(worktreePath)} HEAD`;
}

export function worktreeRemoveCommand(worktreePath: string): string {
  return `git worktree remove --force ${quoteShellArg(worktreePath)}`;
}

export function worktreeDeleteBranchCommand(branchName: string): string {
  return `git branch -D ${quoteShellArg(branchName)}`;
}

/**
 * Shell command to inspect the diff between the worktree and the base commit.
 */
export function worktreeDiffCommand(worktreePath: string, baseRef = "HEAD"): string {
  return `git -C ${quoteShellArg(worktreePath)} diff ${quoteShellArg(baseRef)}`;
}

/**
 * Shell command to inspect a concise diffstat of changes in the worktree.
 */
export function worktreeDiffStatCommand(worktreePath: string, baseRef = "HEAD"): string {
  return `git -C ${quoteShellArg(worktreePath)} diff --stat ${quoteShellArg(baseRef)}`;
}

/**
 * Shell command to merge the isolated sandbox branch back into current working branch.
 */
export function worktreeMergeCommand(branchName: string, squash = false): string {
  if (squash) {
    return `git merge --squash ${quoteShellArg(branchName)}`;
  }
  return `git merge ${quoteShellArg(branchName)}`;
}

/**
 * Register an active sandbox in runtime memory.
 */
export function registerSandbox(sandbox: WorktreeSandbox): void {
  activeSandboxes.set(sandbox.id, sandbox);
}

/**
 * Get an active sandbox by ID.
 */
export function getSandbox(id: string): WorktreeSandbox | undefined {
  return activeSandboxes.get(id);
}

/**
 * List all active sandboxes.
 */
export function listSandboxes(): WorktreeSandbox[] {
  return Array.from(activeSandboxes.values());
}

/**
 * Unregister or mark a sandbox as finished.
 */
export function unregisterSandbox(id: string, status: "applied" | "discarded" | "merged"): void {
  const existing = activeSandboxes.get(id);
  if (existing) {
    existing.status = status;
    activeSandboxes.delete(id);
  }
}

/**
 * Clears all active sandboxes in memory (primarily for test teardown).
 */
export function clearSandboxes(): void {
  activeSandboxes.clear();
}

