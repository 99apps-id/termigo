import { describe, expect, it } from "vitest";
import {
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
    expect(dayKey(new Date(2026, 11, 31, 23, 59).getTime())).toBe(
      "2026-12-31",
    );
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
