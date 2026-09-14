/**
 * Reconcile persisted subagent runs against a fresh process.
 *
 * `subagentRunStore` persists completed runs so a fan-out can be inspected after
 * a restart, and it restores a row exactly as it was written - including
 * `status: "running"`. But a run is only "running" while THIS process is driving
 * it, so any `running` row read from disk describes a run that died with the
 * previous process. Restored verbatim it stayed `running` forever, which had two
 * effects:
 *
 *   - the UI rendered a subagent that never finishes. `RunProgressHUD`,
 *     `SubagentBatchCard` and the tool card all read these rows, and a fan-out
 *     that ended an hour ago looked like it was still working.
 *   - stale rows were un-evictable. `start()` deliberately protects `running`
 *     rows from the per-session cap ("so a running row is never dropped before
 *     its finish()/fail() lands"), and a row that can never finish is therefore
 *     never dropped either - so the zombies crowded out the real history the
 *     persistence exists to keep.
 *
 * The rest of the app already does this for the main run: `chatStore` calls
 * `runInterruptedPatch` on hydrate to settle a run whose work was cut off by a
 * restart. This is the same reconciliation for the subagent rows.
 *
 * Pure and free of imports, so it is tested without the store's Tauri
 * dependencies.
 */

export type PersistedRunLike = {
  status: string;
  endedAt?: number;
  startedAt?: number;
  durationMs?: number;
  error?: string;
};

/** Message shown for a run whose process went away mid-flight. */
export const INTERRUPTED_MESSAGE =
  "Interrupted: the app stopped while this sub-agent was running.";

/**
 * Settle every `running` row, because none of them can still be running.
 *
 * Only `running` changes. `done` and `error` are untouched: they are terminal and
 * carry the result of real work, so rewriting them would destroy history rather
 * than repair it.
 *
 * `error` rather than a new status on purpose. A new status would have to be
 * handled by every reader (three UI components today) and a missed one would
 * render something unintended; `error` already means "did not complete" and every
 * reader already displays it. The message says why, so it is not mistaken for a
 * failure of the subagent's own work.
 *
 * The timestamps are filled in too: without `endedAt` a settled row would still
 * be measured as in-flight by anything computing a duration, which would grow
 * without bound.
 */
export function reconcileInterruptedRuns<T extends PersistedRunLike>(
  runs: readonly T[],
  now: number,
): { runs: T[]; settled: number } {
  let settled = 0;
  const out = runs.map((run) => {
    if (run.status !== "running") return run;
    settled += 1;
    const startedAt = typeof run.startedAt === "number" ? run.startedAt : now;
    // Never negative: a clock that moved backwards must not produce a negative
    // duration, which some formatters render as "-1s" or "NaN".
    const endedAt = Math.max(now, startedAt);
    return {
      ...run,
      status: "error",
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      error: INTERRUPTED_MESSAGE,
    };
  });
  return { runs: out, settled };
}

/**
 * Reconcile every session in a hydrated store.
 *
 * Returns the same object when nothing needed settling, so a caller can skip the
 * state write and avoid a pointless persist of unchanged data.
 */
export function reconcileInterruptedSessions<T extends PersistedRunLike>(
  bySession: Record<string, T[]>,
  now: number,
): { bySession: Record<string, T[]>; settled: number } {
  let settled = 0;
  let changed = false;
  const out: Record<string, T[]> = {};
  for (const [sessionId, runs] of Object.entries(bySession)) {
    const result = reconcileInterruptedRuns(runs ?? [], now);
    if (result.settled > 0) changed = true;
    settled += result.settled;
    out[sessionId] = result.runs;
  }
  return changed ? { bySession: out, settled } : { bySession, settled: 0 };
}
