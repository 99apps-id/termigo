import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CheckpointEntry } from "@/modules/ai/lib/snapshots";
import {
  ArrowDown01Icon,
  ArrowTurnBackwardIcon,
  Clock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { toast } from "sonner";

const TOOLTIP_CLASS = "rounded-md border-border/60 bg-popover px-2 py-1";

function relativeTime(timestampSecs: number): string {
  const s = Math.floor(Date.now() / 1000 - timestampSecs);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type Props = {
  checkpoints: CheckpointEntry[];
  loading: boolean;
  rollingBackSha: string | null;
  onRollback: (sha: string) => Promise<string | null>;
};

/**
 * Timeline of `checkpoint:` commits with one-click rollback.
 *
 * Collapsed by default: checkpoints are a safety net, not the primary
 * workflow, so they stay out of the way until the user needs them.
 */
export function CheckpointTimeline({
  checkpoints,
  loading,
  rollingBackSha,
  onRollback,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [pendingRollback, setPendingRollback] =
    useState<CheckpointEntry | null>(null);

  if (checkpoints.length === 0 && !loading) return null;

  const confirmRollback = async () => {
    const target = pendingRollback;
    setPendingRollback(null);
    if (!target) return;
    const error = await onRollback(target.sha);
    if (error) {
      toast.error("Rollback failed", { description: error });
    } else {
      toast.success(`Restored to ${target.shortSha}`, {
        description: "Your previous state was checkpointed first.",
      });
    }
  };

  return (
    <div className="shrink-0 border-b border-border/40">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
      >
        <HugeiconsIcon
          icon={Clock01Icon}
          size={13}
          strokeWidth={1.85}
          className="shrink-0"
        />
        <span className="flex-1 text-[12px] font-medium">
          Checkpoints
          {checkpoints.length > 0 ? (
            <span className="ml-1.5 text-[10.5px] font-normal text-muted-foreground/70">
              {checkpoints.length}
            </span>
          ) : null}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 opacity-50 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className="max-h-44 overflow-y-auto px-1.5 pb-1.5">
          {loading && checkpoints.length === 0 ? (
            <div className="flex items-center justify-center gap-1.5 py-3 text-[10.5px] text-muted-foreground">
              <Spinner className="size-3" />
              Loading checkpoints
            </div>
          ) : (
            checkpoints.map((checkpoint) => (
              <div
                key={checkpoint.sha}
                className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-foreground/[0.04]"
              >
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                  {checkpoint.shortSha}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85">
                  {checkpoint.label || "checkpoint"}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                  {relativeTime(checkpoint.timestampSecs)}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-6 shrink-0 cursor-pointer rounded-md p-3 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
                      aria-label={`Roll back to ${checkpoint.shortSha}`}
                      disabled={rollingBackSha !== null}
                      onClick={() => setPendingRollback(checkpoint)}
                    >
                      {rollingBackSha === checkpoint.sha ? (
                        <Spinner className="size-3" />
                      ) : (
                        <HugeiconsIcon
                          icon={ArrowTurnBackwardIcon}
                          size={12}
                          strokeWidth={2}
                        />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="left"
                    className={cn(TOOLTIP_CLASS, "text-[10.5px]")}
                  >
                    Roll back to this checkpoint
                  </TooltipContent>
                </Tooltip>
              </div>
            ))
          )}
        </div>
      ) : null}

      <AlertDialog
        open={pendingRollback !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRollback(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to checkpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRollback
                ? `This resets the working tree to ${pendingRollback.shortSha} (${pendingRollback.label || "checkpoint"}). Uncommitted changes are kept as a new checkpoint first, so you can return to them.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRollback()}>
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
