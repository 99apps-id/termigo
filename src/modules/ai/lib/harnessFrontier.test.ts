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
  bestProfile,
  loadFrontier,
  recordRun,
  resetFrontier,
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
});
