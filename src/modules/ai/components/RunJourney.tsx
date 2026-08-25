import { cn } from "@/lib/utils";
import {
  ArrowTurnBackwardIcon,
  Clock01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { native } from "../lib/native";
import { listCheckpoints, type CheckpointEntry } from "../lib/snapshots";
import { buildJourney, relativeTime, type JourneyEvent } from "../lib/journey";
import { useTrajectoryStore } from "../store/trajectoryStore";
import { useChatStore } from "../store/chatStore";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/10 text-blue-500 animate-pulse",
  success: "bg-emerald-500/10 text-emerald-500",
  error: "bg-destructive/10 text-destructive",
};

function Event({ event, now }: { event: JourneyEvent; now: number }) {
  if (event.kind === "checkpoint") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-left">
        <HugeiconsIcon
          icon={ArrowTurnBackwardIcon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-amber-500"
        />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[11px] font-medium text-foreground">
            checkpoint
          </span>
          <span className="ml-1.5 truncate text-[11px] text-muted-foreground">
            {event.checkpoint.label}
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {event.checkpoint.shortSha}
        </span>
      </div>
    );
  }

  const s = event.step;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/30 bg-background/60 px-2 py-1.5">
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {relativeTime(s.timestamp, now)}
      </span>
      <HugeiconsIcon
        icon={TerminalIcon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
        {s.toolName}
      </span>
      {s.durationMs != null && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {s.durationMs}ms
        </span>
      )}
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          STATUS_STYLE[s.status],
        )}
      >
        {s.status}
      </span>
    </div>
  );
}

/**
 * The run "journey": a single chronological timeline that interleaves the
 * agent's tool steps with the checkpoints it created, so one view shows what
 * the run did and the safe points it left behind.
 */
export function RunJourney({ className }: { className?: string }) {
  const { runs, activeRunId } = useTrajectoryStore();
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const currentRun =
    runs.find((r) => r.runId === activeRunId) ?? runs[runs.length - 1];

  // Reload checkpoints when the run or the workspace changes. Checkpoints are
  // loaded lazily so a workspace without git history shows none rather than a
  // failure.
  useEffect(() => {
    let alive = true;
    setCheckpoints([]);
    if (!workspaceRoot || !currentRun?.runId) return;
    void (async () => {
      try {
        const repo = await native.gitResolveRepo(workspaceRoot);
        if (!alive || !repo) return;
        const cps = await listCheckpoints(repo.repoRoot, 200);
        if (alive) setCheckpoints(cps);
      } catch {
        // No repo, or git unavailable — the journey shows steps only.
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceRoot, currentRun?.runId]);

  const now = useMemo(() => Date.now(), []);

  if (!currentRun) {
    return (
      <div
        className={cn(
          "p-4 text-center text-xs text-muted-foreground",
          className,
        )}
      >
        No run yet. The journey of the next agent run appears here.
      </div>
    );
  }

  const events = buildJourney(currentRun, checkpoints);
  const statusLabel = currentRun.status;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border/40 bg-card/40 p-3 text-xs",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={1.75} />
          Run journey
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{currentRun.modelId}</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              statusLabel === "running"
                ? "bg-blue-500/10 text-blue-500"
                : statusLabel === "failed" || statusLabel === "aborted"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-emerald-500/10 text-emerald-500",
            )}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>{currentRun.steps.length} steps</span>
        {currentRun.totalTokens > 0 && (
          <span>~{currentRun.totalTokens.toLocaleString()} tok</span>
        )}
        {currentRun.totalCostUsd != null && (
          <span>${currentRun.totalCostUsd.toFixed(4)}</span>
        )}
        {checkpoints.length > 0 && <span>{checkpoints.length} checkpoints</span>}
      </div>

      {events.length === 0 ? (
        <div className="p-3 text-center text-[11px] text-muted-foreground">
          No steps recorded for this run.
        </div>
      ) : (
        <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
          {events.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static run events, order never changes
            <Event key={i} event={e} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
