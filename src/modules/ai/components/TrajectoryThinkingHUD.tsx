import { useMemo } from "react";
import { useTrajectoryStore, type TrajectoryStep } from "../store/trajectoryStore";
import { ThinkingTreeHUD, type ThoughtNode } from "./ThinkingTreeHUD";

/** Map a trajectory step's lifecycle onto the HUD's node status. */
function statusFor(step: TrajectoryStep): ThoughtNode["status"] {
  switch (step.status) {
    case "success":
      return "completed";
    case "error":
      return "failed";
    default:
      return "running";
  }
}

/** A short human label for the step's arguments, so the tree reads as actions
 *  rather than raw tool names. */
function detailFor(step: TrajectoryStep): string | undefined {
  const args = step.args ?? {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  const target = pick("path", "command", "pattern", "query", "fact", "prompt");
  if (!target) return undefined;
  return target.length > 80 ? `${target.slice(0, 77)}…` : target;
}

function toNodes(steps: readonly TrajectoryStep[]): ThoughtNode[] {
  return steps.map((step) => ({
    id: step.id,
    title: step.toolName,
    type: "tool",
    status: statusFor(step),
    details: detailFor(step),
    durationMs: step.durationMs,
  }));
}

/**
 * Live view of the current run's tool calls as a reasoning tree. Reads the
 * trajectory store that the run loop fills, so it shows real steps rather than
 * a static placeholder. Renders nothing when there is no active run.
 */
export function TrajectoryThinkingHUD({ className }: { className?: string }) {
  const runs = useTrajectoryStore((s) => s.runs);
  const activeRunId = useTrajectoryStore((s) => s.activeRunId);

  const nodes = useMemo(() => {
    const run =
      runs.find((r) => r.runId === activeRunId) ?? runs[runs.length - 1];
    if (!run) return [];
    return toNodes(run.steps);
  }, [runs, activeRunId]);

  if (nodes.length === 0) return null;

  return <ThinkingTreeHUD nodes={nodes} className={className} />;
}
