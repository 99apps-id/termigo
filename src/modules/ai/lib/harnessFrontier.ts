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

export type FrontierGroup = {
  id: string;
  runs: number;
  successes: number;
  totalSteps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  lastAt: number;
  rate: number;
  avgCost: number;
  avgCache: number;
};

export type FrontierSummary = {
  groups: FrontierGroup[];
  best: { id: string; stats: FrontierGroup; score: number } | null;
};

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

let writeChain: Promise<unknown> = Promise.resolve();

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
  const next = writeChain.then(async () => {
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
      runs: (Number(prev.runs) || 0) + 1,
      successes: (Number(prev.successes) || 0) + (outcome.success ? 1 : 0),
      totalSteps: (Number(prev.totalSteps) || 0) + (Number(outcome.steps) || 0),
      totalInputTokens:
        (Number(prev.totalInputTokens) || 0) + (Number(outcome.inputTokens) || 0),
      totalOutputTokens:
        (Number(prev.totalOutputTokens) || 0) +
        (Number(outcome.outputTokens) || 0),
      totalCachedTokens:
        (Number(prev.totalCachedTokens) || 0) +
        (Number(outcome.cachedTokens) || 0),
      totalCostUsd:
        (Number(prev.totalCostUsd) || 0) + (Number(outcome.costUsd) || 0),
      lastAt: Date.now(),
    };
    await saveFrontier(record);
    return record;
  });
  writeChain = next.catch(() => {});
  return next;
}

/** Summarize frontier record across profiles without NaN values. */
export function summarizeFrontier(record: FrontierRecord): FrontierSummary {
  const map = new Map<string, FrontierGroup>();
  for (const [key, stats] of Object.entries(record ?? {})) {
    if (!stats || typeof stats !== "object") continue;
    const id = key.includes("::") ? key.slice(key.indexOf("::") + 2) : key;
    const prev = map.get(id) ?? {
      id,
      runs: 0,
      successes: 0,
      totalSteps: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostUsd: 0,
      lastAt: 0,
      rate: 0,
      avgCost: 0,
      avgCache: 0,
    };
    prev.runs += Number(stats.runs) || 0;
    prev.successes += Number(stats.successes) || 0;
    prev.totalSteps += Number(stats.totalSteps) || 0;
    prev.totalInputTokens += Number(stats.totalInputTokens) || 0;
    prev.totalOutputTokens += Number(stats.totalOutputTokens) || 0;
    prev.totalCachedTokens += Number(stats.totalCachedTokens) || 0;
    prev.totalCostUsd += Number(stats.totalCostUsd) || 0;
    prev.lastAt = Math.max(prev.lastAt, Number(stats.lastAt) || 0);
    map.set(id, prev);
  }

  const groups = [...map.values()].map((g) => {
    const runs = g.runs > 0 ? g.runs : 0;
    const rate = runs > 0 ? g.successes / runs : 0;
    const avgCost = runs > 0 ? g.totalCostUsd / runs : 0;
    const totalInput = Math.max(g.totalInputTokens, g.totalCachedTokens);
    const avgCache =
      totalInput > 0 ? (g.totalCachedTokens / totalInput) * 100 : 0;

    return {
      ...g,
      rate: Number.isFinite(rate) ? rate : 0,
      avgCost: Number.isFinite(avgCost) ? avgCost : 0,
      avgCache: Number.isFinite(avgCache) ? avgCache : 0,
    };
  });

  groups.sort((a, b) => {
    const costA = Math.max(0, a.avgCost);
    const costB = Math.max(0, b.avgCost);
    const scoreA = Number.isFinite(a.rate / (1 + costA))
      ? a.rate / (1 + costA)
      : 0;
    const scoreB = Number.isFinite(b.rate / (1 + costB))
      ? b.rate / (1 + costB)
      : 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.runs - a.runs;
  });

  const bestGroup = groups[0] ?? null;
  const bestScore = bestGroup
    ? Number.isFinite(bestGroup.rate / (1 + Math.max(0, bestGroup.avgCost)))
      ? bestGroup.rate / (1 + Math.max(0, bestGroup.avgCost))
      : 0
    : 0;

  return {
    groups,
    best:
      bestGroup !== null
        ? { id: bestGroup.id, stats: bestGroup, score: bestScore }
        : null,
  };
}

/** Best profile for a workspace by a composite score.
 *
 * Score = successRate * (1 / (1 + avgCostUsd)) -- profiles that succeed often
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
      const runs = Number(stats?.runs) || 0;
      const successes = Number(stats?.successes) || 0;
      const totalCostUsd = Number(stats?.totalCostUsd) || 0;
      const rate = runs > 0 ? successes / runs : 0;
      const avgCost = runs > 0 ? totalCostUsd / runs : 0;
      const score = Number.isFinite(rate / (1 + Math.max(0, avgCost)))
        ? rate / (1 + Math.max(0, avgCost))
        : 0;
      return { id, stats, score };
    });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.stats?.runs || 0) - (a.stats?.runs || 0);
  });
  return candidates[0];
}

/** Helper: average cost per run for a profile, for UI. */
export function avgCostUsd(stats: FrontierStats): number {
  const runs = Number(stats?.runs) || 0;
  const cost = Number(stats?.totalCostUsd) || 0;
  return runs > 0 ? cost / runs : 0;
}

/** Helper: average cache hit % for a profile. */
export function avgCachePct(stats: FrontierStats): number {
  const cached = Number(stats?.totalCachedTokens) || 0;
  const total = Math.max(Number(stats?.totalInputTokens) || 0, cached);
  return total > 0 ? (cached / total) * 100 : 0;
}

/** Reset hook for tests and the settings UI. */
export function resetFrontier(): Promise<void> {
  const next = writeChain.then(() => saveFrontier({}));
  writeChain = next.catch(() => {});
  return next;
}
