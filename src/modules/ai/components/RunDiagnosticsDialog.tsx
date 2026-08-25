import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChatStore } from "../store/chatStore";
import type { RunDiagnostics } from "../lib/agent";

/**
 * Reads the last run's performance summary. The run-log line already answers
 * "why is it slow" but only in the app log; this puts the same numbers on
 * screen, so a user does not have to read a file to learn the prompt is 38 KB.
 */
export function RunDiagnosticsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const lastRun = useChatStore((s) => s.lastRun);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            Last run — why it was (or was not) slow
          </DialogTitle>
        </DialogHeader>

        {!lastRun ? (
          <div className="flex items-center justify-center px-6 py-10 text-center text-[11px] leading-relaxed text-muted-foreground">
            No run measured yet. The next agent run will appear here with its
            context-assembly time, prompt size breakdown, cache hit rate and why
            it stopped.
          </div>
        ) : (
          <RunSummary run={lastRun} />
        )}

        <div className="flex justify-end border-t border-border pt-2.5">
          <Button size="xs" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const kb = (n: number) => (n / 1024).toFixed(1);

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-right text-[11.5px] font-medium text-foreground">
        {value}
        {hint ? (
          <span className="ml-1 font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </div>
  );
}

export function RunSummary({ run }: { run: RunDiagnostics }) {
  const stoppedAt = run.stopReason ?? (run.finishReason || "done");
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-1">
        <Row label="Model" value={run.modelId} />
        <Row label="Provider" value={run.provider} />
      </div>
      <Row
        label="Context assembly"
        value={`${run.contextMs} ms`}
        hint="before the first token"
      />
      <Row
        label="Prompt size"
        value={`${kb(run.promptBytes.total)} KB`}
        hint={`sys ${kb(run.promptBytes.system)} · proj ${kb(
          run.promptBytes.project,
        )} · mem ${kb(run.promptBytes.learned)} · tools ${kb(
          run.promptBytes.tools,
        )} (${run.toolCount})`}
      />
      <Row
        label="Tokens"
        value={`${run.tokens.input} in · ${run.tokens.output} out`}
        hint={`${run.tokens.cached} cached`}
      />
      <Row label="Cache hit" value={`${run.cachePct}%`} />
      <Row
        label="Steps"
        value={`${run.steps}/${run.stepBudget}`}
        hint={run.compactedAway != null ? `compacted ${run.compactedAway}` : undefined}
      />
      <Row
        label="Context limit"
        value={
          run.contextLimit > 0 ? `${run.contextLimit.toLocaleString()}` : "n/a"
        }
      />
      <Row
        label="Stopped"
        value={stoppedAt}
        hint={new Date(run.at).toLocaleTimeString()}
      />
      {run.estimatedCostUsd != null ? (
        <Row
          label="Estimated cost"
          value={`$${run.estimatedCostUsd.toFixed(4)}`}
          hint={
            run.costBudgetUsd > 0
              ? `budget $${run.costBudgetUsd.toFixed(2)}`
              : undefined
          }
        />
      ) : null}
      {run.stopReason === "cost-cap" ? (
        <Row
          label="Cost cap"
          value="hit"
          hint="Run stopped because the budget was reached."
        />
      ) : null}
    </div>
  );
}
