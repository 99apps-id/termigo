import { beforeEach, describe, expect, it, vi } from "vitest";

// The frontier persists to a Tauri LazyStore (unavailable in node tests), so
// stub the plugin with an in-memory map.
vi.mock("@tauri-apps/plugin-store", () => {
  const data = new Map<string, unknown>();
  class FakeLazyStore {
    constructor(
      public path: string,
      public opts: unknown,
    ) {
      void this.path;
      void this.opts;
    }
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    }
  }
  return { LazyStore: FakeLazyStore };
});

import {
  avgCachePct,
  avgCostUsd,
  bestProfile,
  loadFrontier,
  recordRun,
  resetFrontier,
  summarizeFrontier,
} from "./harnessFrontier";

describe("harnessFrontier", () => {
  beforeEach(async () => {
    await resetFrontier();
  });

  it("records a run and accumulates stats", async () => {
    await recordRun("/ws", "balanced", { success: true, steps: 5 });
    await recordRun("/ws", "balanced", { success: false, steps: 8 });
    const record = await loadFrontier();
    const stat = record["/ws::balanced"];
    expect(stat).toMatchObject({ runs: 2, successes: 1, totalSteps: 13 });
  });

  it("splits stats per workspace and profile", async () => {
    await recordRun("/ws", "balanced", { success: true, steps: 5 });
    await recordRun("/other", "no_todo", { success: true, steps: 3 });
    const record = await loadFrontier();
    expect(record["/ws::balanced"].runs).toBe(1);
    expect(record["/other::no_todo"].runs).toBe(1);
  });

  it("suggests the profile with the best success rate", async () => {
    await recordRun("/ws", "balanced", { success: false, steps: 5 });
    await recordRun("/ws", "balanced", { success: false, steps: 5 });
    await recordRun("/ws", "no_todo", { success: true, steps: 3 });
    const best = await bestProfile("/ws");
    expect(best?.id).toBe("no_todo");
  });

  it("returns null when there is no data for a workspace", async () => {
    expect(await bestProfile("/never")).toBeNull();
  });

  it("clears the frontier on reset", async () => {
    await recordRun("/ws", "balanced", { success: true, steps: 1 });
    await resetFrontier();
    expect(await loadFrontier()).toEqual({});
  });

  it("never produces NaN for avgCache, avgCost, or score when token counts are zero or missing", async () => {
    await recordRun("/ws", "balanced", { success: true, steps: 2 });
    const record = await loadFrontier();
    const stat = record["/ws::balanced"];

    expect(Number.isNaN(avgCostUsd(stat))).toBe(false);
    expect(Number.isNaN(avgCachePct(stat))).toBe(false);
    expect(avgCostUsd(stat)).toBe(0);
    expect(avgCachePct(stat)).toBe(0);

    const summary = summarizeFrontier(record);
    expect(summary.groups).toHaveLength(1);
    const group = summary.groups[0];
    expect(Number.isNaN(group.rate)).toBe(false);
    expect(Number.isNaN(group.avgCost)).toBe(false);
    expect(Number.isNaN(group.avgCache)).toBe(false);
    expect(group.avgCache).toBe(0);
    expect(group.avgCost).toBe(0);
    expect(group.rate).toBe(1);

    expect(summary.best).not.toBeNull();
    expect(Number.isNaN(summary.best?.score)).toBe(false);
    expect(summary.best?.score).toBe(1);

    const best = await bestProfile("/ws");
    expect(best).not.toBeNull();
    expect(Number.isNaN(best?.score)).toBe(false);
  });

  it("handles malformed or partial records safely in summarizeFrontier", () => {
    const malformed = {
      "/ws::broken": {
        runs: 3,
        successes: 2,
        totalSteps: 4,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCostUsd: Number.NaN,
        lastAt: 0,
      },
    };
    const summary = summarizeFrontier(malformed);
    expect(summary.groups).toHaveLength(1);
    expect(Number.isNaN(summary.groups[0].avgCost)).toBe(false);
    expect(Number.isNaN(summary.groups[0].avgCache)).toBe(false);
    expect(Number.isNaN(summary.best?.score)).toBe(false);
  });
});
