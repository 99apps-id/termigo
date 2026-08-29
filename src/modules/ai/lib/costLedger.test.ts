import { describe, expect, it } from "vitest";
import {
  aggregateByDay,
  aggregateByModel,
  type CostEntry,
  dayKey,
  entriesForWorkspace,
  entriesOnDay,
  MAX_AGE_DAYS,
  pruneEntries,
  sumCost,
} from "./costLedger";

function entry(over: Partial<CostEntry> = {}): CostEntry {
  return {
    at: Date.now(),
    day: dayKey(Date.now()),
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: "/repo",
    costUsd: 0.01,
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 500,
    ...over,
  };
}

describe("dayKey", () => {
  it("formats a local YYYY-MM-DD day", () => {
    expect(dayKey(new Date(2026, 0, 5, 13, 30).getTime())).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 11, 31, 23, 59).getTime())).toBe("2026-12-31");
  });
});

describe("pruneEntries", () => {
  it("drops entries older than the retention window", () => {
    const now = Date.now();
    const fresh = entry({ at: now - 1000 });
    const old = entry({ at: now - (MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000 });
    expect(pruneEntries([old, fresh], now)).toEqual([fresh]);
  });

  it("keeps an entry exactly at the cutoff", () => {
    const now = Date.now();
    const edge = entry({ at: now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000 });
    expect(pruneEntries([edge], now)).toEqual([edge]);
  });
});

describe("sumCost", () => {
  it("adds up the cost of every entry", () => {
    expect(
      sumCost([entry({ costUsd: 0.01 }), entry({ costUsd: 0.02 })]),
    ).toBeCloseTo(0.03);
  });

  it("is 0 for an empty ledger", () => {
    expect(sumCost([])).toBe(0);
  });
});

describe("entriesOnDay", () => {
  it("selects only the matching day", () => {
    const a = entry({ day: "2026-01-05", costUsd: 0.01 });
    const b = entry({ day: "2026-01-06", costUsd: 0.02 });
    expect(entriesOnDay([a, b], "2026-01-06")).toEqual([b]);
  });
});

describe("entriesForWorkspace", () => {
  it("selects only the matching workspace", () => {
    const a = entry({ workspaceRoot: "/repo-a" });
    const b = entry({ workspaceRoot: "/repo-b" });
    expect(entriesForWorkspace([a, b], "/repo-b")).toEqual([b]);
  });

  it("returns nothing when no workspace is open", () => {
    expect(entriesForWorkspace([entry()], null)).toEqual([]);
  });
});

describe("aggregateByModel", () => {
  it("rolls cost and tokens up per model, most-expensive first", () => {
    const rows = aggregateByModel([
      entry({
        modelId: "a",
        costUsd: 0.02,
        inputTokens: 100,
        outputTokens: 10,
      }),
      entry({
        modelId: "b",
        costUsd: 0.05,
        inputTokens: 200,
        outputTokens: 20,
      }),
      entry({
        modelId: "a",
        costUsd: 0.03,
        inputTokens: 300,
        outputTokens: 30,
      }),
    ]);
    expect(rows.map((r) => r.modelId)).toEqual(["a", "b"]);
    const a = rows.find((r) => r.modelId === "a");
    expect(a?.costUsd).toBeCloseTo(0.05);
    expect(a?.inputTokens).toBe(400);
    expect(a?.runs).toBe(2);
  });

  it("is empty for no entries", () => {
    expect(aggregateByModel([])).toEqual([]);
  });
});

describe("aggregateByDay", () => {
  it("rolls cost up per day, most-recent first, capped to the limit", () => {
    const rows = aggregateByDay(
      [
        entry({ day: "2026-08-27", costUsd: 0.01 }),
        entry({ day: "2026-08-29", costUsd: 0.02 }),
        entry({ day: "2026-08-29", costUsd: 0.03 }),
        entry({ day: "2026-08-28", costUsd: 0.04 }),
      ],
      2,
    );
    expect(rows.map((r) => r.day)).toEqual(["2026-08-29", "2026-08-28"]);
    expect(rows[0].costUsd).toBeCloseTo(0.05);
    expect(rows[0].runs).toBe(2);
  });
});
