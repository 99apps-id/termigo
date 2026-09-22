// Harness frontier — records how each harness profile performed on verifiable
// runs in a workspace and suggests the best one.
//
// The reward is deliberately simple and honest: a run that settled cleanly
// (the model finished with a summary, no guard stopped it) counts as a success.
// Success rate per (workspace, profile) is the signal; the best profile for a
// workspace is the one with the highest success rate (ties by most runs).
//
// Cost awareness: we also record tokens, cache hit %, and estimated cost so the
// frontier can surface the profile that is both reliable AND cheap. A profile
// that succeeds 90% but burns 5× the tokens is a bad default.

import { LazyStore } from "@tauri-apps/plugin-store";

const STORE_PATH = "termigo-harness-frontier.json";
const frontierKey = (workspace: string, profileId: string) =>
  `${workspace}::${profileId}`;

export type FrontierStats = {
  runs: number;
  successes: number;
  totalSteps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
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
  outcome: {
    success: boolean;
    steps: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    costUsd?: number;
  },
): Promise<FrontierRecord> {
  const record = await loadFrontier();
  const key = frontierKey(workspace, profileId);
  const prev = record[key] ?? {
    runs: 0,
    successes: 0,
    totalSteps: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalCostUsd: 0,
    lastAt: 0,
  };
  record[key] = {
    runs: prev.runs + 1,
    successes: prev.successes + (outcome.success ? 1 : 0),
    totalSteps: prev.totalSteps + outcome.steps,
    totalInputTokens: prev.totalInputTokens + (outcome.inputTokens ?? 0),
    totalOutputTokens: prev.totalOutputTokens + (outcome.outputTokens ?? 0),
    totalCachedTokens: prev.totalCachedTokens + (outcome.cachedTokens ?? 0),
    totalCostUsd: prev.totalCostUsd + (outcome.costUsd ?? 0),
    lastAt: Date.now(),
  };
  await saveFrontier(record);
  return record;
}

/** Best profile for a workspace by a composite score.
 *
 * Score = successRate * (1 / (1 + avgCostUsd)) — profiles that succeed often
 * AND cost less rank higher. Ties broken by most runs.
 */
export async function bestProfile(
  workspace: string,
): Promise<{ id: string; stats: FrontierStats; score: number } | null> {
  const record = await loadFrontier();
  const prefix = `${workspace}::`;
  const candidates = Object.entries(record)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, stats]) => {
      const id = key.slice(prefix.length);
      const rate = stats.runs ? stats.successes / stats.runs : 0;
      const avgCost = stats.runs ? stats.totalCostUsd / stats.runs : 0;
      const score = rate / (1 + avgCost);
      return { id, stats, score };
    });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.stats.runs - a.stats.runs;
  });
  return candidates[0];
}

/** Helper: average cost per run for a profile, for UI. */
export function avgCostUsd(stats: FrontierStats): number {
  return stats.runs ? stats.totalCostUsd / stats.runs : 0;
}

/** Helper: average cache hit % for a profile. */
export function avgCachePct(stats: FrontierStats): number {
  const total = stats.totalInputTokens + stats.totalCachedTokens;
  return total ? (stats.totalCachedTokens / total) * 100 : 0;
}

/** Reset hook for tests and the settings UI. */
export function resetFrontier(): Promise<void> {
  return saveFrontier({});
}