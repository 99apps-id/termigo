// Persistent per-run cost ledger. Every finished agent run appends one entry,
// keyed by day, so "what did today cost" and "what did this project cost this
// week" have an answer that survives a restart. The per-run estimate already
// exists (RunDiagnostics.estimatedCostUsd); this is the part that remembers it.

import { LazyStore } from "@tauri-apps/plugin-store";

export type CostEntry = {
  /** Epoch ms the run finished. */
  at: number;
  /** Local calendar day, YYYY-MM-DD, for cheap day bucketing. */
  day: string;
  modelId: string;
  provider: string;
  /** Workspace the run happened in; null when none was open. */
  workspaceRoot: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
};

const STORE_PATH = "termigo-cost-ledger.json";
const KEY_ENTRIES = "entries";
// Keep roughly three months of history; older rows are dropped on write so the
// file cannot grow without bound.
export const MAX_AGE_DAYS = 92;

export function dayKey(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Drop entries older than the retention window, order preserved. */
export function pruneEntries(
  entries: readonly CostEntry[],
  now: number,
): CostEntry[] {
  const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter((e) => e.at >= cutoff);
}

export function sumCost(entries: readonly CostEntry[]): number {
  return entries.reduce((sum, e) => sum + e.costUsd, 0);
}

export function entriesOnDay(
  entries: readonly CostEntry[],
  day: string,
): CostEntry[] {
  return entries.filter((e) => e.day === day);
}

export function entriesForWorkspace(
  entries: readonly CostEntry[],
  workspaceRoot: string | null,
): CostEntry[] {
  if (!workspaceRoot) return [];
  return entries.filter((e) => e.workspaceRoot === workspaceRoot);
}

export type ModelSpend = {
  modelId: string;
  provider: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  runs: number;
};

/** Roll the ledger up per model, most-expensive first — the "where did the
 *  money go" breakdown a cost panel leads with. */
export function aggregateByModel(entries: readonly CostEntry[]): ModelSpend[] {
  const byModel = new Map<string, ModelSpend>();
  for (const e of entries) {
    const cur = byModel.get(e.modelId) ?? {
      modelId: e.modelId,
      provider: e.provider,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      runs: 0,
    };
    cur.costUsd += e.costUsd;
    cur.inputTokens += e.inputTokens;
    cur.outputTokens += e.outputTokens;
    cur.cachedTokens += e.cachedTokens;
    cur.runs += 1;
    byModel.set(e.modelId, cur);
  }
  return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export type DaySpend = { day: string; costUsd: number; runs: number };

/** Roll the ledger up per calendar day, most-recent first — the last `limit`
 *  days for a compact spend-over-time list. */
export function aggregateByDay(
  entries: readonly CostEntry[],
  limit = 14,
): DaySpend[] {
  const byDay = new Map<string, DaySpend>();
  for (const e of entries) {
    const cur = byDay.get(e.day) ?? { day: e.day, costUsd: 0, runs: 0 };
    cur.costUsd += e.costUsd;
    cur.runs += 1;
    byDay.set(e.day, cur);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, limit);
}

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadCostLedger(): Promise<CostEntry[]> {
  try {
    const entries = await store.get<CostEntry[]>(KEY_ENTRIES);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

export async function recordRunCost(entry: CostEntry): Promise<void> {
  const entries = await loadCostLedger();
  const next = [...pruneEntries(entries, entry.at), entry];
  await store.set(KEY_ENTRIES, next);
  await store.save();
}

/** Total cost for a given day (YYYY-MM-DD). */
export async function costOnDay(day: string): Promise<number> {
  return sumCost(entriesOnDay(await loadCostLedger(), day));
}

/** Total cost so far today (local time). */
export async function costToday(): Promise<number> {
  return costOnDay(dayKey(Date.now()));
}

/** Total cost for a workspace across all retained history. */
export async function costForWorkspace(
  workspaceRoot: string | null,
): Promise<number> {
  return sumCost(entriesForWorkspace(await loadCostLedger(), workspaceRoot));
}

export async function clearCostLedger(): Promise<void> {
  await store.set(KEY_ENTRIES, []);
  await store.save();
}
