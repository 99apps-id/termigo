import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Clock01Icon, TerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { loadTrajectoryRuns } from "../lib/trajectoryIo";
import type { TrajectoryRun } from "../store/trajectoryStore";
import { RunJourney } from "./RunJourney";

const STATUS_STYLE: Record<TrajectoryRun["status"], string> = {
  running: "bg-blue-500/10 text-blue-500",
  completed: "bg-emerald-500/10 text-emerald-500",
  failed: "bg-destructive/10 text-destructive",
  aborted: "bg-destructive/10 text-destructive",
};

/**
 * Replay past agent runs after a restart. Finished runs are persisted to disk
 * (see trajectoryIo.ts); this lists them newest-first and shows the selected
 * one through the same RunJourney timeline the live run uses.
 */
export function RunReplayDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [runs, setRuns] = useState<TrajectoryRun[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const all = await loadTrajectoryRuns();
    setRuns(all);
    setSelectedId((prev) =>
      prev && all.some((r) => r.runId === prev)
        ? prev
        : (all[all.length - 1]?.runId ?? null),
    );
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const selected = runs?.find((r) => r.runId === selectedId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[13px]">
            <HugeiconsIcon icon={Clock01Icon} size={15} strokeWidth={1.75} />
            Run replay
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 md:grid-cols-[230px_1fr]">
          <div className="min-h-0">
            {runs === null ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : runs.length === 0 ? (
              <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                No runs recorded yet. Finished agent runs appear here and
                survive restarts.
              </div>
            ) : (
              <ScrollArea className="max-h-80">
                <ul className="flex flex-col gap-1 pr-1">
                  {[...runs].reverse().map((run) => (
                    <li key={run.runId}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(run.runId)}
                        className={cn(
                          "w-full rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                          run.runId === selectedId
                            ? "border-border bg-accent"
                            : "border-border/50 bg-card hover:bg-accent/50",
                        )}
                      >
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          <HugeiconsIcon
                            icon={TerminalIcon}
                            size={11}
                            strokeWidth={1.75}
                            className="shrink-0 text-muted-foreground"
                          />
                          <span className="truncate">
                            {new Date(run.startedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="truncate font-mono">
                            {run.modelId}
                          </span>
                          <span className="shrink-0">
                            {run.steps.length} steps
                          </span>
                          <span
                            className={cn(
                              "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                              STATUS_STYLE[run.status],
                            )}
                          >
                            {run.status}
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>

          <div className="min-h-0">
            {selected ? (
              <RunJourney run={selected} />
            ) : (
              <div className="flex h-full min-h-24 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
                {runs !== null && runs.length > 0
                  ? "Select a run to replay it."
                  : "Nothing to replay yet."}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end border-t border-border pt-2.5">
          <Button size="xs" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
