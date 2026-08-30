import { toast } from "@/components/ui/toast";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { native } from "../lib/native";
import {
  type CheckpointEntry,
  listCheckpoints,
  rollbackToCheckpoint,
} from "../lib/snapshots";
import { useChatStore } from "../store/chatStore";

/**
 * After a failed run, offer a one-click undo to the last checkpoint the agent
 * (or user) took. Mounted inside the AiChat error banner; read-only until
 * clicked, so it only lists checkpoints and never mutates on its own.
 */
export function RollbackSuggestion() {
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<CheckpointEntry | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!workspaceRoot) return;
      try {
        const repo = await native.gitResolveRepo(workspaceRoot);
        if (!repo || !alive) return;
        const checkpoints = await listCheckpoints(repo.repoRoot, 1);
        if (!alive || checkpoints.length === 0) return;
        setRepoRoot(repo.repoRoot);
        setCheckpoint(checkpoints[0]);
      } catch {
        // No repo, or git unavailable — show no suggestion.
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceRoot]);

  if (!repoRoot || !checkpoint) return null;

  const undo = async () => {
    if (busy) return;
    const ok = window.confirm(
      `Roll the working tree back to the last checkpoint?\n\n` +
        `“${checkpoint.label}” · ${checkpoint.shortSha}\n\n` +
        `Your current changes are checkpointed first, so this can be undone.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await rollbackToCheckpoint(repoRoot, checkpoint.sha);
      if (res.ok) {
        toast(`Rolled back to checkpoint ${checkpoint.shortSha}`, {
          variant: "success",
        });
      } else {
        toast(res.error || "Rollback failed", { variant: "error" });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Rollback failed", {
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void undo()}
      disabled={busy}
      title="Restore the working tree to the last checkpoint (your current changes are checkpointed first, so this can be undone)"
      className="flex items-center gap-1.5 rounded bg-amber-500/20 px-2 py-0.5 font-medium text-amber-600 hover:bg-amber-500/30 disabled:opacity-50"
    >
      <HugeiconsIcon
        icon={ArrowTurnBackwardIcon}
        size={12}
        strokeWidth={1.75}
      />
      {busy ? "Rolling back…" : "Undo to last checkpoint"}
    </button>
  );
}
