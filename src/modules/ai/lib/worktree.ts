/**
 * Git Worktree Isolation Layer (Ephemeral Sandbox)
 *
 * Allows agents to perform risky or large multi-file edits in an isolated
 * git worktree sandbox before applying them to the user's working tree.
 */

import { quoteShellArg } from "@/lib/shellQuote";
import { native } from "./native";

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
  const sanitized = taskId
    ?.replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "");
  // 40-char bound: the id becomes a directory segment under .wt/ AND a branch
  // name, and an unbounded subagent label walks the whole path back into the
  // Windows MAX_PATH wall the short .wt/ prefix exists to avoid.
  const bounded =
    sanitized && sanitized.length > 40
      ? sanitized.slice(0, 40).replace(/_+$/, "")
      : sanitized;
  const cleanId = bounded || Math.random().toString(36).slice(2, 9);
  const branchName = `termigo-sandbox/${cleanId}`;
  const subpath = `.wt/${cleanId}`;
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
export function worktreeAddCommand(
  worktreePath: string,
  branchName: string,
): string {
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
export function worktreeDiffCommand(
  worktreePath: string,
  baseRef = "HEAD",
): string {
  return `git -C ${quoteShellArg(worktreePath)} diff ${quoteShellArg(baseRef)}`;
}

/**
 * Shell command to inspect a concise diffstat of changes in the worktree.
 */
export function worktreeDiffStatCommand(
  worktreePath: string,
  baseRef = "HEAD",
): string {
  return `git -C ${quoteShellArg(worktreePath)} diff --stat ${quoteShellArg(baseRef)}`;
}

/**
 * Shell command to merge the isolated sandbox branch back into current working branch.
 */
export function worktreeMergeCommand(
  branchName: string,
  squash = false,
): string {
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
export function unregisterSandbox(
  id: string,
  status: "applied" | "discarded" | "merged",
): void {
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

/** How long a sandbox may sit untouched before it is considered stale. */
const STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The main repository root a sandbox worktree hangs off, derived from the
 * `.wt/<id>` layout. `git worktree remove` refuses to run from inside the
 * worktree being removed, so cleanup commands run from here.
 */
export function repoRootOfWorktree(worktreePath: string): string | null {
  const norm = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const at = norm.lastIndexOf("/.wt/");
  if (at <= 0) return null;
  return norm.slice(0, at);
}

/**
 * Remove sandboxes older than `STALE_AGE_MS` from the registry and attempt to
 * delete their worktrees and branches from disk. Intentionally fire-and-forget:
 * a failed cleanup is logged but never blocks the caller.
 *
 * Only sees sandboxes THIS process registered — after a restart the registry is
 * empty and leftovers are surfaced by `worktree_list` (git is the authority)
 * for the user or agent to discard.
 */
export async function cleanupStaleSandboxes(): Promise<void> {
  const now = Date.now();
  const stale: WorktreeSandbox[] = [];
  for (const sb of activeSandboxes.values()) {
    if (now - sb.createdAt > STALE_AGE_MS) {
      stale.push(sb);
    }
  }
  if (stale.length === 0) return;

  for (const sb of stale) {
    activeSandboxes.delete(sb.id);
    const root = repoRootOfWorktree(sb.worktreePath);
    if (!root) {
      console.warn(
        `[worktree] stale sandbox ${sb.id}: cannot derive repo root from ${sb.worktreePath}`,
      );
      continue;
    }
    try {
      await native.runCommand(worktreeRemoveCommand(sb.worktreePath), root, 30);
      await native.runCommand(
        worktreeDeleteBranchCommand(sb.branchName),
        root,
        30,
      );
    } catch (e) {
      console.warn(`[worktree] failed to clean stale sandbox ${sb.id}:`, e);
    }
  }
}

/** Where sandboxes live, relative to the workspace root. */
export const WORKTREE_SUBPATH_PREFIX = ".wt/";

/** A sandbox that exists on disk, whether or not this process created it. */
export type DiscoveredWorktree = {
  /** Sandbox id, taken from the directory name that `generateSandboxInfo` built. */
  id: string;
  worktreePath: string;
  branchName: string;
};

/**
 * Find Termigo sandboxes by looking at GIT rather than at memory.
 *
 * The registry above is a plain in-memory Map, so it knows only about the
 * sandboxes THIS process created. The worktrees themselves live on disk and
 * survive a restart, which means after any restart `worktree_list` reported
 * nothing while `.wt/<id>` directories and
 * `termigo-sandbox/<id>` branches were still there. Those became invisible:
 * nothing could list them and `worktree_discard` could not remove them, because
 * it looks the sandbox up by id. Subagent isolation makes that more likely, since
 * a subagent creates a worktree on request.
 *
 * Git is the authority on which worktrees exist, so this reads them from there.
 * Pure and taking plain entries, so it is tested without a repository.
 *
 * The prefix filter is load-bearing: a user may have their own worktrees, and
 * treating one of those as a Termigo sandbox would offer to delete it.
 */
export function discoveredWorktrees(
  branches: readonly {
    name: string;
    kind: string;
    worktreePath: string | null;
  }[],
): DiscoveredWorktree[] {
  const out: DiscoveredWorktree[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    if (branch.kind !== "worktree" || !branch.worktreePath) continue;
    // Git reports native separators, so match on both.
    const normalised = branch.worktreePath.replace(/\\/g, "/");
    let id: string | null = null;
    if (normalised.startsWith(WORKTREE_SUBPATH_PREFIX)) {
      // A relative worktree path (`.wt/xyz`) has no leading slash to find.
      id = normalised.slice(WORKTREE_SUBPATH_PREFIX.length);
    } else {
      const at = normalised.lastIndexOf(`/${WORKTREE_SUBPATH_PREFIX}`);
      // Require the marker to be a whole path segment, not a prefix of a longer
      // directory name (`.../x.termigo/wt/`).
      if (at >= 0) {
        id = normalised.slice(at + WORKTREE_SUBPATH_PREFIX.length + 1);
      }
    }
    // A nested path is not a sandbox root; `generateSandboxInfo` makes one level.
    if (!id || id.includes("/") || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      worktreePath: branch.worktreePath,
      branchName: branch.name,
    });
  }
  return out;
}
