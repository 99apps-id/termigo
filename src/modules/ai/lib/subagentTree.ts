/**
 * Subagent fan-out aggregation, ported from Hermes' subagent tree helpers.
 *
 * Hermes reconstructs a full spawn tree from `parentId` links; Termigo's
 * `SubagentRun` records carry only a nesting `depth` (no parent pointer), so
 * the port keeps what is still meaningful without one: per-depth widths (which
 * drive the unicode sparkline — the "shape" of the fan-out at a glance) and
 * flat totals for the summary line. Both are pure functions over run-like
 * records so the live HUD and any future replay view share them.
 */

/** Minimal shape the helpers need — satisfied by `SubagentRun`. */
export type SubagentRunLike = {
  depth?: number;
  status: string;
  stepCount?: number;
  durationMs?: number;
};

/** Totals across a set of subagent runs. */
export type SubagentTotals = {
  /** Total runs (any status). */
  agents: number;
  /** Runs still in flight. */
  active: number;
  /** Runs that errored. */
  failed: number;
  /** Sum of per-run step counts. */
  steps: number;
  /** Sum of per-run durations, in ms. */
  durationMs: number;
  /** Deepest nesting level seen (0 = flat / unknown). */
  maxDepth: number;
};

/** Runs deeper than this are clamped — a corrupt record cannot blow up the array. */
const MAX_DEPTH_INDEX = 8;

function isRunning(status: string): boolean {
  return status === "running";
}

/**
 * Count of runs at each nesting depth, indexed by depth. Drives the sparkline
 * so the eye reads the fan-out's shape (wide at the top, tapering down) without
 * counting rows. Missing depths are treated as 0; over-deep ones are clamped.
 */
export function widthByDepth(runs: readonly SubagentRunLike[]): number[] {
  const widths: number[] = [];
  for (const r of runs) {
    const d = Math.min(
      MAX_DEPTH_INDEX,
      Math.max(0, Math.trunc(r.depth ?? 0)),
    );
    widths[d] = (widths[d] ?? 0) + 1;
  }
  // Fill holes so index i always exists up to the deepest populated level.
  for (let i = 0; i < widths.length; i++) {
    if (widths[i] === undefined) widths[i] = 0;
  }
  return widths;
}

const SPARK_RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * 8-step unicode bar sparkline from a positive-integer array. Zeroes render as
 * spaces so a sparse tree does not read as equal activity at every depth.
 * Empty input yields an empty string; an all-zero input yields spaces.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return " ".repeat(values.length);
  return values
    .map((v) => {
      if (v <= 0) return " ";
      const idx = Math.min(
        SPARK_RAMP.length - 1,
        Math.max(0, Math.ceil((v / max) * (SPARK_RAMP.length - 1))),
      );
      return SPARK_RAMP[idx];
    })
    .join("");
}

/** Flat totals across all runs — feeds the HUD summary line. */
export function aggregateRuns(runs: readonly SubagentRunLike[]): SubagentTotals {
  let active = 0;
  let failed = 0;
  let steps = 0;
  let durationMs = 0;
  let maxDepth = 0;
  for (const r of runs) {
    if (isRunning(r.status)) active += 1;
    if (r.status === "error") failed += 1;
    steps += r.stepCount ?? 0;
    durationMs += r.durationMs ?? 0;
    const d = Math.trunc(r.depth ?? 0);
    if (Number.isFinite(d) && d > maxDepth) maxDepth = d;
  }
  return { agents: runs.length, active, failed, steps, durationMs, maxDepth };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Compact one-line summary: `4 agents · 2 running · d2 · 124 steps · 2m 14s`.
 * Pieces with nothing to report are omitted so a single quick run does not
 * render a wall of zeros.
 */
export function formatRunSummary(totals: SubagentTotals): string {
  if (totals.agents === 0) return "";
  const pieces = [
    `${totals.agents} agent${totals.agents === 1 ? "" : "s"}`,
  ];
  if (totals.active > 0) pieces.push(`${totals.active} running`);
  if (totals.failed > 0) pieces.push(`${totals.failed} failed`);
  if (totals.maxDepth > 1) pieces.push(`d${totals.maxDepth}`);
  if (totals.steps > 0) pieces.push(`${totals.steps} steps`);
  if (totals.durationMs > 0) pieces.push(fmtDuration(totals.durationMs));
  return pieces.join(" · ");
}
