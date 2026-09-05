import { memo } from "react";
import { stepBudgetForRound } from "../config";
import type { AgentStopReason } from "../lib/agent";

export const MemoryNotice = memo(function MemoryNotice({
  fact,
  onDismiss,
}: {
  fact: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-2xs dark:border-border/40 dark:bg-muted/30">
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-sky-500/80" />
      <span className="flex-1">
        <span className="font-medium text-foreground">Remembered</span>
        {" - "}
        {fact}
        <span className="mt-0.5 block opacity-75">
          Kept in .termigo/memory.md and added to every later run. Edit or
          delete it there.
        </span>
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-[10.5px] underline opacity-75 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

export const CompactionNotice = memo(function CompactionNotice({
  droppedCount,
  onDismiss,
}: {
  droppedCount: number;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-2xs dark:border-border/40 dark:bg-muted/30">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500/80" />
      <span className="flex-1 truncate">
        Context compacted - {droppedCount} older tool result
        {droppedCount === 1 ? "" : "s"} elided to save tokens.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline opacity-75 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

export const PruneNotice = memo(function PruneNotice({
  prunedMessages,
  onDismiss,
}: {
  prunedMessages: number;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-2xs dark:border-border/40 dark:bg-muted/30">
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/80" />
      <span className="flex-1 truncate">
        Context pruned - {prunedMessages} verified message
        {prunedMessages === 1 ? "" : "s"} replaced by a checkpoint summary to
        save tokens.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline opacity-75 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

export type StopKind = AgentStopReason | "stopped";

export function stopCopy(
  kind: StopKind,
  round: number,
): { text: string; action: string; hint?: string } {
  const spent = stepBudgetForRound(round);
  const next = stepBudgetForRound(round + 1);
  const deeper = next > spent ? ` (next round: ${next})` : "";
  switch (kind) {
    case "step-cap":
      return {
        text: `Paused after ${spent} steps - this round's budget.`,
        action: `Continue${deeper}`,
      };
    case "tool-repetition":
      return {
        text: "Stopped: the same tool ran three times with identical input.",
        hint: "Another round would likely repeat it. Adding a detail usually helps more.",
        action: "Continue anyway",
      };
    case "no-progress":
      return {
        text: "Stopped: two turns in a row made no tool call.",
        hint: "The agent was describing rather than doing. Say what to change.",
        action: "Continue anyway",
      };
    case "tool-error":
      return {
        text: "Stopped: three turns in a row, every tool call failed.",
        hint: "The agent kept hitting a failing tool. Check the command/path it was trying, then continue.",
        action: "Continue anyway",
      };
    case "cost-cap":
      return {
        text: "Stopped: reached the maximum cost budget for this run.",
        hint: "Adjust the cost budget in settings if you wish to allow higher spend.",
        action: "Continue anyway",
      };
    case "stopped":
    case "steered":
    case "aborted":
      return { text: "You stopped this run.", action: "Resume" };
    case "interrupted":
      return {
        text: "This run was interrupted - the app closed or the run was cut off.",
        hint: "Your progress is preserved. Resume to pick up where it stopped.",
        action: "Resume",
      };
  }
}

export const ContinueRow = memo(function ContinueRow({
  kind,
  round,
  onContinue,
}: {
  kind: StopKind;
  round: number;
  onContinue: () => void;
}) {
  const copy = stopCopy(kind, round);
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-[11px] shadow-2xs dark:border-border/50 dark:bg-card/60">
      <span className="flex-1 text-muted-foreground">
        {copy.text}
        {copy.hint && (
          <span className="mt-0.5 block opacity-75">{copy.hint}</span>
        )}
      </span>
      <button
        type="button"
        onClick={onContinue}
        className="shrink-0 rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
      >
        {copy.action}
      </button>
    </div>
  );
});
