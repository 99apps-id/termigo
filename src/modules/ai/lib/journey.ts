// Pure rules for the run "journey" - a single chronological timeline that
// interleaves the agent's tool steps with the workspace checkpoints it took,
// so one view shows what the run did and the safe points it left behind.
//
// The merging and time-window filtering are pure and exported for tests; the
// component that loads checkpoints from git is a thin I/O wrapper.

import type { TrajectoryRun, TrajectoryStep } from "../store/trajectoryStore";
import type { CheckpointEntry } from "./snapshots";

export type JourneyEvent =
  | { kind: "step"; at: number; step: TrajectoryStep }
  | { kind: "checkpoint"; at: number; checkpoint: CheckpointEntry };

/**
 * Merge a run's steps and the checkpoints it created into one chronology.
 *
 * A checkpoint belongs to the journey only when it was taken inside the run's
 * own time window, so an earlier manual checkpoint does not get attributed to
 * this run.
 */
export function buildJourney(
  run: Pick<TrajectoryRun, "startedAt" | "finishedAt" | "steps">,
  checkpoints: readonly CheckpointEntry[],
): JourneyEvent[] {
  const end = run.finishedAt ?? Date.now();

  const steps: JourneyEvent[] = run.steps.map((step) => ({
    kind: "step" as const,
    at: step.timestamp,
    step,
  }));

  const cps: JourneyEvent[] = checkpoints
    .filter((c) => {
      const at = c.timestampSecs * 1000;
      return at >= run.startedAt && at <= end;
    })
    .map((c) => ({
      kind: "checkpoint" as const,
      at: c.timestampSecs * 1000,
      checkpoint: c,
    }));

  return [...steps, ...cps].sort((a, b) => a.at - b.at);
}

/** Compact relative time for the timeline, mirroring the block bar's idiom. */
export function relativeTime(at: number, now = Date.now()): string {
  const d = Math.max(0, now - at);
  if (d < 1000) return "now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}
