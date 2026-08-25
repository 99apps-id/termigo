/**
 * Git Worktree Isolation Layer (Ephemeral Sandbox)
 *
 * Allows agents to perform risky or large multi-file edits in an isolated
 * git worktree sandbox before applying them to the user's working tree.
 */

export type WorktreeSandbox = {
  id: string;
  branchName: string;
  worktreePath: string;
  createdAt: number;
  status: "active" | "applied" | "discarded";
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
export function unregisterSandbox(id: string, status: "applied" | "discarded"): void {
  const existing = activeSandboxes.get(id);
  if (existing) {
    existing.status = status;
    activeSandboxes.delete(id);
  }
}
