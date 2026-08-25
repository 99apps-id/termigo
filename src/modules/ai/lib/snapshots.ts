import { native, type GitLogEntry } from "./native";
import { quoteShellArg } from "@/lib/shellQuote";

/**
 * Workspace snapshots, built on ordinary git commits.
 *
 * A checkpoint is a normal commit whose subject starts with `checkpoint:` —
 * the same shape the `git_checkpoint` agent tool creates. Keeping it a commit
 * means the snapshot shows up in the existing git history, needs no extra
 * storage, and rolls back with a plain `git reset --hard`.
 *
 * The command builders are pure and exported so the exact shell line is
 * testable; the thin functions that actually invoke git stay untested, per the
 * repo convention for I/O wrappers.
 */

export const CHECKPOINT_PREFIX = "checkpoint:";

/** A git object id is 7-40 hex chars; anything else is refused, not guessed. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function isValidSha(sha: string): boolean {
  return SHA_RE.test(sha.trim());
}

export function isCheckpointSubject(subject: string): boolean {
  return subject.trim().startsWith(CHECKPOINT_PREFIX);
}

/** The human label after the `checkpoint:` prefix. */
export function checkpointLabel(subject: string): string {
  return subject.trim().slice(CHECKPOINT_PREFIX.length).trim();
}

/** Stage everything so the snapshot captures untracked files too. */
export function checkpointAddCommand(): string {
  return "git add -A";
}

/**
 * The commit step, kept separate from `git add` instead of chaining with `&&`.
 * The one-shot runner uses the user's login shell, and PowerShell 5.1 does not
 * understand `&&`; two sequential calls behave the same everywhere.
 */
export function checkpointCommitCommand(label: string): string {
  const clean = label.trim() || "checkpoint";
  return `git commit -m ${quoteShellArg(`${CHECKPOINT_PREFIX} ${clean}`)}`;
}

export function rollbackResetCommand(sha: string): string {
  return `git reset --hard ${quoteShellArg(sha.trim())}`;
}

export type CheckpointEntry = {
  sha: string;
  shortSha: string;
  label: string;
  timestampSecs: number;
};

/** Pure filter over a git log; exported for tests. */
export function checkpointsFromLog(entries: readonly GitLogEntry[]): CheckpointEntry[] {
  return entries
    .filter((entry) => isCheckpointSubject(entry.subject))
    .map((entry) => ({
      sha: entry.sha,
      shortSha: entry.shortSha,
      label: checkpointLabel(entry.subject),
      timestampSecs: entry.timestampSecs,
    }));
}

export async function listCheckpoints(
  repoRoot: string,
  limit = 200,
): Promise<CheckpointEntry[]> {
  const log = await native.gitLog(repoRoot, { limit });
  return checkpointsFromLog(log);
}

export type CreateCheckpointResult = {
  created: boolean;
  error?: string;
};

/**
 * Snapshot the working tree as a `checkpoint:` commit.
 *
 * A clean tree is a success with `created: false` rather than an error: HEAD
 * already is the snapshot, so there is nothing to protect.
 */
export async function createCheckpoint(
  repoRoot: string,
  label: string,
): Promise<CreateCheckpointResult> {
  const add = await native.runCommand(checkpointAddCommand(), repoRoot, 60);
  if (add.exit_code !== 0) {
    return { created: false, error: add.stderr.trim() || "git add failed" };
  }
  const commit = await native.runCommand(
    checkpointCommitCommand(label),
    repoRoot,
    60,
  );
  if (commit.exit_code !== 0) {
    const combined = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit/i.test(combined)) {
      return { created: false };
    }
    return { created: false, error: commit.stderr.trim() || "git commit failed" };
  }
  return { created: true };
}

export type RollbackResult = { ok: boolean; error?: string };

/**
 * Restore the working tree to a checkpoint.
 *
 * Before resetting, the current state is itself checkpointed (when dirty) so
 * the rollback can be undone from the same timeline. Without that, a mistaken
 * restore would destroy exactly the work the feature exists to protect.
 */
export async function rollbackToCheckpoint(
  repoRoot: string,
  sha: string,
): Promise<RollbackResult> {
  if (!isValidSha(sha)) {
    return { ok: false, error: "Invalid checkpoint reference." };
  }
  try {
    await createCheckpoint(repoRoot, "before rollback");
  } catch {
    // A failed pre-rollback snapshot is reported by the reset below if that
    // also fails; it should not itself block restoring a known-good state.
  }
  const reset = await native.runCommand(rollbackResetCommand(sha), repoRoot, 120);
  if (reset.exit_code !== 0) {
    return { ok: false, error: reset.stderr.trim() || "git reset failed" };
  }
  return { ok: true };
}

/**
 * Auto-checkpoint used before an agent run.
 *
 * Resolves the enclosing repository itself because the transport only knows
 * the workspace root. Every failure is swallowed on purpose: a snapshot is a
 * safety net, and a net that can block the run it is meant to protect would be
 * worse than none.
 */
export async function autoCheckpointForRun(
  workspaceRoot: string | null,
): Promise<void> {
  if (!workspaceRoot) return;
  try {
    const repo = await native.gitResolveRepo(workspaceRoot);
    if (!repo) return;
    await createCheckpoint(repo.repoRoot, "auto before run");
  } catch {
    // Never let checkpointing break the run.
  }
}
