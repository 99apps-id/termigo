// Age-based eviction for the per-session runtime maps.
//
// The boundary cases matter more than the happy path here: evicting an entry
// that is still in use is a correctness bug the user would feel (a resumed run
// losing its throttle, a running session losing its anchor), while failing to
// evict is only the leak this exists to prevent.

import { describe, expect, it } from "vitest";
import { pruneStale } from "./pruneStale";

const TTL = 60_000;

describe("pruneStale", () => {
  it("drops entries older than the window", () => {
    const now = 1_000_000;
    const map = new Map<string, number>([
      ["old", now - TTL - 1],
      ["fresh", now - 1_000],
    ]);
    expect(pruneStale(map, (v) => v, now, TTL)).toBe(1);
    expect([...map.keys()]).toEqual(["fresh"]);
  });

  it("keeps an entry exactly at the boundary", () => {
    // `>` rather than `>=`: a value sitting on the edge is still inside its
    // window, and dropping it would cut a window short by one tick.
    const now = 1_000_000;
    const map = new Map<string, number>([
      ["edge", now - TTL],
      ["other", now - 5_000],
    ]);
    expect(pruneStale(map, (v) => v, now, TTL)).toBe(0);
    expect(map.size).toBe(2);
  });

  it("keeps everything when nothing is stale", () => {
    const now = 1_000_000;
    const map = new Map<string, number>([
      ["a", now - 1],
      ["b", now - 2],
      ["c", now - 3],
    ]);
    expect(pruneStale(map, (v) => v, now, TTL)).toBe(0);
    expect(map.size).toBe(3);
  });

  it("never evicts on a clock that moved backwards", () => {
    // A laptop sleep or an NTP step can make `now` smaller than a value's
    // timestamp. Evicting then would throw away live state.
    const map = new Map<string, number>([
      ["future", 2_000_000],
      ["future2", 2_000_001],
    ]);
    expect(pruneStale(map, (v) => v, 1_000_000, TTL)).toBe(0);
    expect(map.size).toBe(2);
  });

  it("works for a record that carries its own timestamp", () => {
    // The shape the run anchor uses.
    type Anchor = { cwd: string | null; at: number };
    const now = 1_000_000;
    const map = new Map<string, Anchor>([
      ["stale", { cwd: "/old", at: now - TTL - 1 }],
      ["live", { cwd: "/new", at: now }],
    ]);
    expect(pruneStale(map, (v) => v.at, now, TTL)).toBe(1);
    expect([...map.keys()]).toEqual(["live"]);
  });

  it("is a no-op for a single entry, which cannot be stale while in use", () => {
    // The short circuit that keeps the hot path free.
    const now = 1_000_000;
    let reads = 0;
    const map = new Map<string, number>([["only", now - TTL * 100]]);
    expect(
      pruneStale(
        map,
        (v) => {
          reads += 1;
          return v;
        },
        now,
        TTL,
      ),
    ).toBe(0);
    expect(reads).toBe(0);
    expect(map.size).toBe(1);
  });

  it("empties a map where every entry is stale", () => {
    const now = 1_000_000;
    const map = new Map<string, number>([
      ["a", now - TTL - 1],
      ["b", now - TTL - 2],
    ]);
    expect(pruneStale(map, (v) => v, now, TTL)).toBe(2);
    expect(map.size).toBe(0);
  });
});
