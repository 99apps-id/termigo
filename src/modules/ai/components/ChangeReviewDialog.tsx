import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useChatStore } from "../store/chatStore";
import { native, type GitChangedFile } from "../lib/native";

/**
 * One place to see everything the agent (or anyone) changed in the working
 * tree: a file list, status labels, and a unified diff, with per-file revert.
 * The agent's tools already surface this to the model; this is the human view.
 */
export function ChangeReviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [branch, setBranch] = useState<string>("");
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [selected, setSelected] = useState<GitChangedFile | null>(null);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDiff("");
    try {
      const live = useChatStore.getState().live;
      const cwd = live.getWorkspaceRoot() ?? live.getCwd();
      if (!cwd) {
        setError("no workspace root; open a project first");
        return;
      }
      const repo = await native.gitResolveRepo(cwd);
      if (!repo) {
        setError("not a git repository");
        return;
      }
      const status = await native.gitStatus(repo.repoRoot);
      setRepoRoot(repo.repoRoot);
      setBranch(repo.branch);
      setFiles(status.changedFiles);
      setSelected(null);
      const whole = await native.gitDiff(repo.repoRoot, null, false);
      setDiff(whole.diffText);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
    else {
      setFiles([]);
      setSelected(null);
      setDiff("");
      setError(null);
    }
  }, [open, load]);

  const selectFile = async (file: GitChangedFile) => {
    setSelected(file);
    if (!repoRoot) return;
    try {
      const res = await native.gitDiff(repoRoot, file.path, file.staged);
      setDiff(res.diffText);
    } catch (e) {
      setDiff(`(could not read diff: ${String(e)})`);
    }
  };

  const revertFile = async (file: GitChangedFile) => {
    if (!repoRoot || file.untracked) {
      toast.info("Untracked files cannot be reverted here.");
      return;
    }
    try {
      await native.gitDiscard(repoRoot, [{ path: file.path, untracked: false }]);
      toast.success(`Reverted ${file.path}`);
      await load();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const revertAll = async () => {
    if (!repoRoot) return;
    const tracked = files.filter((f) => !f.untracked);
    if (tracked.length === 0) {
      toast.info("No tracked changes to revert.");
      return;
    }
    try {
      await native.gitDiscard(
        repoRoot,
        tracked.map((f) => ({ path: f.path, untracked: false })),
      );
      toast.success("Reverted all tracked changes");
      await load();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const shownDiff = diff;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            Change review — {branch || "working tree"}
            {files.length > 0 ? ` · ${files.length} file(s)` : ""}
          </DialogTitle>
        </DialogHeader>

        {error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
            {error}
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
            Loading…
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <ul className="w-56 shrink-0 space-y-1 overflow-y-auto pr-1">
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => void selectFile(f)}
                    className="flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-[10px] transition-colors hover:bg-accent/50"
                  >
                    <span className="truncate font-medium">{f.path}</span>
                    <span
                      className={
                        "shrink-0 rounded px-1 py-0.5 text-[9px] " +
                        (f.staged
                          ? "bg-accent text-foreground"
                          : "bg-muted text-muted-foreground")
                      }
                    >
                      {f.statusLabel || f.indexStatus}
                    </span>
                  </button>
                </li>
              ))}
              {files.length === 0 ? (
                <li className="px-2 py-1 text-[10px] text-muted-foreground">
                  Working tree is clean.
                </li>
              ) : null}
            </ul>

            <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card/60 p-2.5 text-[10px] leading-relaxed">
              {shownDiff || (selected ? "No diff for this file." : "No diff.")}
            </pre>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
          <span className="text-[10px] text-muted-foreground">
            Untracked files are shown but not reverted from here.
          </span>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={!selected || selected.untracked || !repoRoot}
              onClick={() => selected && void revertFile(selected)}
            >
              Revert file
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={files.length === 0 || !repoRoot}
              onClick={() => void revertAll()}
            >
              Revert all tracked
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={loading}
              onClick={() => void load()}
            >
              Refresh
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
