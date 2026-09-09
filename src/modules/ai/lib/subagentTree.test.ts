import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  formatRunSummary,
  sparkline,
  widthByDepth,
} from "./subagentTree";

const run = (over: Partial<Parameters<typeof aggregateRuns>[0][number]> = {}) =>
  ({
    status: "running",
    ...over,
  }) as Parameters<typeof aggregateRuns>[0][number];

describe("widthByDepth", () => {
  it("returns an empty array for no runs", () => {
    expect(widthByDepth([])).toEqual([]);
  });

  it("counts runs per nesting depth", () => {
    expect(
      widthByDepth([
        run({ depth: 0 }),
        run({ depth: 0 }),
        run({ depth: 1 }),
        run({ depth: 2 }),
        run({ depth: 2 }),
        run({ depth: 2 }),
      ]),
    ).toEqual([2, 1, 3]);
  });

  it("treats a missing depth as 0", () => {
    expect(widthByDepth([run(), run({ depth: 1 })])).toEqual([1, 1]);
  });

  it("fills gaps so index i always exists", () => {
    expect(widthByDepth([run({ depth: 0 }), run({ depth: 3 })])).toEqual([
      1, 0, 0, 1,
    ]);
  });

  it("clamps absurd depths instead of allocating a huge array", () => {
    const widths = widthByDepth([run({ depth: 10_000 })]);
    expect(widths.length).toBeLessThanOrEqual(9);
    expect(widths[8]).toBe(1);
  });

  it("clamps negative depths to 0", () => {
    expect(widthByDepth([run({ depth: -3 })])).toEqual([1]);
  });
});

describe("sparkline", () => {
  it("renders an empty string for no values", () => {
    expect(sparkline([])).toBe("");
  });

  it("renders spaces for all-zero values", () => {
    expect(sparkline([0, 0, 0])).toBe("   ");
  });

  it("scales bars relative to the max", () => {
    // 4 vs 8 vs 2: max maps to the top block, half to mid, quarter lower.
    const s = sparkline([4, 8, 2]);
    expect(s).toHaveLength(3);
    expect(s[1]).toBe("█");
    expect(s.charCodeAt(0)).toBeLessThan(s.charCodeAt(1));
    expect(s.charCodeAt(2)).toBeLessThan(s.charCodeAt(0));
  });

  it("renders a uniform ramp for equal values", () => {
    expect(sparkline([3, 3, 3])).toBe("███");
  });

  it("keeps a nonzero count off the blank floor", () => {
    const s = sparkline([1, 1000]);
    expect(s[0]).not.toBe(" ");
  });
});

describe("aggregateRuns", () => {
  it("aggregates an empty set to zeros", () => {
    expect(aggregateRuns([])).toEqual({
      agents: 0,
      active: 0,
      failed: 0,
      steps: 0,
      durationMs: 0,
      maxDepth: 0,
    });
  });

  it("counts statuses, sums steps and durations, tracks max depth", () => {
    const totals = aggregateRuns([
      run({ status: "running", stepCount: 3, durationMs: 1000, depth: 0 }),
      run({ status: "running", stepCount: 5, durationMs: 2000, depth: 2 }),
      run({ status: "done", stepCount: 7, durationMs: 4000, depth: 1 }),
      run({ status: "error", durationMs: 500 }),
    ]);
    expect(totals).toEqual({
      agents: 4,
      active: 2,
      failed: 1,
      steps: 15,
      durationMs: 7500,
      maxDepth: 2,
    });
  });

  it("treats missing counters as zero", () => {
    expect(aggregateRuns([run({ status: "done" })]).steps).toBe(0);
  });
});

describe("formatRunSummary", () => {
  it("returns an empty string for no agents", () => {
    expect(formatRunSummary(aggregateRuns([]))).toBe("");
  });

  it("reports the basics for a flat single run", () => {
    const s = formatRunSummary(
      aggregateRuns([run({ status: "done", stepCount: 4, durationMs: 1500 })]),
    );
    expect(s).toContain("1 agent");
    expect(s).toContain("4 steps");
    expect(s).toContain("1.5s");
    // No noise for a flat, all-success run.
    expect(s).not.toContain("running");
    expect(s).not.toContain("failed");
    expect(s).not.toContain("d");
  });

  it("includes depth only when nested deeper than 1", () => {
    expect(
      formatRunSummary(aggregateRuns([run({ depth: 1 })])),
    ).not.toContain("d1");
    expect(formatRunSummary(aggregateRuns([run({ depth: 2 })]))).toContain(
      "d2",
    );
  });

  it("includes running and failed counts when present", () => {
    const s = formatRunSummary(
      aggregateRuns([
        run({ status: "running" }),
        run({ status: "running" }),
        run({ status: "error" }),
      ]),
    );
    expect(s).toContain("3 agents");
    expect(s).toContain("2 running");
    expect(s).toContain("1 failed");
  });

  it("pluralizes agents correctly", () => {
    expect(formatRunSummary(aggregateRuns([run()]))).toContain("1 agent");
    expect(formatRunSummary(aggregateRuns([run(), run()]))).toContain(
      "2 agents",
    );
  });

  it("formats minutes for long runs", () => {
    const s = formatRunSummary(
      aggregateRuns([run({ status: "done", durationMs: 134_000 })]),
    );
    expect(s).toContain("2m 14s");
  });
});
