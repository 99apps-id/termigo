import { useCallback, useEffect, useState } from "react";
import {
  type CheckpointEntry,
  listCheckpoints,
  rollbackToCheckpoint,
} from "@/modules/ai/lib/snapshots";

/**
 * Checkpoint timeline for the source control panel.
 *
 * Loads lazily while the panel is closed so opening it never waits on a git
 * log, and reloads whenever the panel opens because agent runs create
 * checkpoints in the background, outside any event this hook can see.
 */
export function useCheckpoints(repoRoot: string | null, open: boolean) {
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBackSha, setRollingBackSha] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoRoot) {
      setCheckpoints([]);
      return;
    }
    setLoading(true);
    try {
      setCheckpoints(await listCheckpoints(repoRoot));
    } catch {
      // A failed log read leaves the previous list in place; an empty panel
      // with a retry path is better than an error state for a side feature.
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const rollback = useCallback(
    async (sha: string): Promise<string | null> => {
      if (!repoRoot) return "No repository.";
      setRollingBackSha(sha);
      try {
        const result = await rollbackToCheckpoint(repoRoot, sha);
        if (!result.ok) return result.error ?? "Rollback failed.";
        await refresh();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "Rollback failed.";
      } finally {
        setRollingBackSha(null);
      }
    },
    [repoRoot, refresh],
  );

  return { checkpoints, loading, rollingBackSha, refresh, rollback };
}
