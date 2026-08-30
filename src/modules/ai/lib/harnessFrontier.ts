// Harness frontier — records how each harness profile performed on verifiable
// runs in a workspace and suggests the best one.
//
// The reward is deliberately simple and honest: a run that settled cleanly
// (the model finished with a summary, no guard stopped it) counts as a success.
// Success rate per (workspace, profile) is the signal; the best profile for a
// workspace is the one with the highest success rate (ties by most runs).

import { LazyStore } from "@tauri-apps/plugin-store";

const STORE_PATH = "termigo-harness-frontier.json";
const frontierKey = (workspace: string, profileId: string) =>
  `${workspace}::${profileId}`;

export type FrontierStats = {
  runs: number;
  successes: number;
  totalSteps: number;
  lastAt: number;
};

export type FrontierRecord = Record<string, FrontierStats>;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadFrontier(): Promise<FrontierRecord> {
  try {
    const raw = await store.get<unknown>("frontier");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as FrontierRecord;
    }
  } catch {
    // ignore
  }
  return {};
}

export async function saveFrontier(record: FrontierRecord): Promise<void> {
  await store.set("frontier", record);
}

/** Record one run outcome for (workspace, profile). */
export async function recordRun(
  workspace: string,
  profileId: string,
  outcome: { success: boolean; steps: number },
): Promise<FrontierRecord> {
  const record = await loadFrontier();
  const key = frontierKey(workspace, profileId);
  const prev = record[key] ?? {
    runs: 0,
    successes: 0,
    totalSteps: 0,
    lastAt: 0,
  };
  record[key] = {
    runs: prev.runs + 1,
    successes: prev.successes + (outcome.success ? 1 : 0),
    totalSteps: prev.totalSteps + outcome.steps,
    lastAt: Date.now(),
  };
  await saveFrontier(record);
  return record;
}

/** Best profile for a workspace by success rate (ties broken by most runs). */
export async function bestProfile(
  workspace: string,
): Promise<{ id: string; stats: FrontierStats } | null> {
  const record = await loadFrontier();
  const prefix = `${workspace}::`;
  const candidates = Object.entries(record)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, stats]) => ({ id: key.slice(prefix.length), stats }));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const rateA = a.stats.runs ? a.stats.successes / a.stats.runs : 0;
    const rateB = b.stats.runs ? b.stats.successes / b.stats.runs : 0;
    if (rateA !== rateB) return rateB - rateA;
    return b.stats.runs - a.stats.runs;
  });
  return candidates[0];
}

/** Reset hook for tests and the settings UI. */
export function resetFrontier(): Promise<void> {
  return saveFrontier({});
}
