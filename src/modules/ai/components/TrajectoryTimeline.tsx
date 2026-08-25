import { useTrajectoryStore, type TrajectoryStep } from "../store/trajectoryStore";
import { cn } from "@/lib/utils";

function StatusBadge({ status }: { status: TrajectoryStep["status"] }) {
  const styles = {
    pending: "bg-muted text-muted-foreground",
    running: "bg-blue-500/10 text-blue-500 animate-pulse",
    success: "bg-emerald-500/10 text-emerald-500",
    error: "bg-destructive/10 text-destructive",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

export function TrajectoryTimeline({ className }: { className?: string }) {
  const { runs, activeRunId, selectedStepId, selectStep } = useTrajectoryStore();
  const currentRun = runs.find((r) => r.runId === activeRunId) || runs[runs.length - 1];

  if (!currentRun || currentRun.steps.length === 0) {
    return (
      <div className={cn("p-4 text-center text-xs text-muted-foreground", className)}>
        No active execution trajectory. Steps will appear here as the agent runs.
      </div>
    );
  }

  const selectedStep = currentRun.steps.find((s) => s.id === selectedStepId);

  return (
    <div className={cn("flex flex-col gap-3 p-3 bg-card/40 rounded-lg border border-border/40 text-xs", className)}>
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
        <div className="font-semibold text-foreground">Agent Trajectory Timeline</div>
        <div className="text-[11px] text-muted-foreground">
          {currentRun.steps.length} step{currentRun.steps.length > 1 ? "s" : ""} | Model: {currentRun.modelId}
        </div>
      </div>

      <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
        {currentRun.steps.map((step, idx) => (
          <button
            type="button"
            key={step.id}
            onClick={() => selectStep(step.id === selectedStepId ? null : step.id)}
            className={cn(
              "flex items-center justify-between p-2 rounded border text-left transition-colors",
              selectedStepId === step.id
                ? "bg-accent/70 border-accent-foreground/20"
                : "bg-background/60 border-border/30 hover:bg-accent/30",
            )}
          >
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="text-[11px] text-muted-foreground font-mono">#{idx + 1}</span>
              <span className="font-mono font-medium truncate text-foreground">{step.toolName}</span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {step.durationMs != null && (
                <span className="text-[10px] text-muted-foreground">{step.durationMs}ms</span>
              )}
              <StatusBadge status={step.status} />
            </div>
          </button>
        ))}
      </div>

      {selectedStep && (
        <div className="mt-2 p-2.5 rounded bg-muted/40 border border-border/30 text-[11px] font-mono space-y-1.5 overflow-x-auto">
          <div className="text-muted-foreground font-semibold">Arguments:</div>
          <pre className="text-[10px] overflow-x-auto">{JSON.stringify(selectedStep.args, null, 2)}</pre>
          {selectedStep.output != null && (
            <>
              <div className="text-muted-foreground font-semibold mt-1">Output:</div>
              <pre className="text-[10px] overflow-x-auto">{JSON.stringify(selectedStep.output, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
