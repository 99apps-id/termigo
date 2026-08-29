// Persistence for the trajectory store, so a run's journey survives a restart
// and can be replayed from the Run replay dialog. One entry per finished run,
// newest kept first, bounded so the file cannot grow without bound.

import { LazyStore } from "@tauri-apps/plugin-store";
import type { TrajectoryRun } from "../store/trajectoryStore";

const STORE_PATH = "termigo-ai-trajectory.json";
const KEY_RUNS = "runs";
/** How many past runs to keep for replay. */
export const MAX_RUNS = 50;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** Upsert a run by id and keep only the newest `max` runs (oldest dropped). */
export function mergeRuns(
  runs: readonly TrajectoryRun[],
  run: TrajectoryRun,
  max = MAX_RUNS,
): TrajectoryRun[] {
  return [...runs.filter((r) => r.runId !== run.runId), run].slice(-max);
}

/** Upsert a run (by runId) and cap the list at the newest MAX_RUNS. */
export async function saveTrajectoryRun(run: TrajectoryRun): Promise<void> {
  const runs = await loadTrajectoryRuns();
  await store.set(KEY_RUNS, mergeRuns(runs, run));
  await store.save();
}

/** All persisted runs, oldest first. */
export async function loadTrajectoryRuns(): Promise<TrajectoryRun[]> {
  return (await store.get<TrajectoryRun[]>(KEY_RUNS)) ?? [];
}

export async function clearTrajectoryRuns(): Promise<void> {
  await store.set(KEY_RUNS, []);
  await store.save();
}
