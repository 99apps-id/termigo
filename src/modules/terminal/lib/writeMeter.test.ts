import { describe, expect, it } from "vitest";
import {
  createWriteMeter,
  STALL_CAP,
  WRITE_HIGH_WATER,
  WRITE_LOW_WATER,
} from "./writeMeter";

// A controllable xterm-write stand-in: it records what was written and lets the
// test decide WHEN each write's parse callback fires (like xterm's throttled
// drain), so we can drive the meter into and out of the stalled state.
function harness() {
  const written: string[] = [];
  const pending: (() => void)[] = [];
  const write = (chunk: Uint8Array | string, done: () => void) => {
    written.push(
      typeof chunk === "string" ? chunk : `bytes:${chunk.byteLength}`,
    );
    pending.push(done);
  };
  const flushOne = () => pending.shift()?.();
  const flushAll = () => {
    // Draining re-enters write, so keep going until the queue truly empties.
    while (pending.length) pending.shift()?.();
  };
  return {
    written,
    write,
    flushOne,
    flushAll,
    pendingCount: () => pending.length,
  };
}

const chunk = (n: number) => new Uint8Array(n);

describe("createWriteMeter", () => {
  it("writes straight through while the parser keeps up", () => {
    const h = harness();
    const m = createWriteMeter(h.write, () => false);
    m.push(chunk(1000));
    expect(h.written).toHaveLength(1);
    expect(m.held()).toBe(0);
    expect(m.outstanding()).toBe(1000);
    h.flushAll();
    expect(m.outstanding()).toBe(0);
  });

  it("holds the tail once outstanding passes the high-water mark", () => {
    const h = harness();
    const m = createWriteMeter(h.write, () => false);
    // First push exceeds high-water and is written (accepted but not parsed).
    m.push(chunk(WRITE_HIGH_WATER + 1));
    expect(h.written).toHaveLength(1);
    // Now outstanding > high-water and nothing has drained: further pushes hold.
    m.push(chunk(5000));
    expect(h.written).toHaveLength(1); // not written
    expect(m.held()).toBe(5000);
  });

  it("flushes the held tail once the parser drains below the low-water mark", () => {
    const h = harness();
    const m = createWriteMeter(h.write, () => false);
    m.push(chunk(WRITE_HIGH_WATER + 1));
    m.push(chunk(5000)); // held
    expect(m.held()).toBe(5000);
    // Parse the big chunk: outstanding drops to 0 (< low-water) → held flushes.
    h.flushAll();
    expect(m.held()).toBe(0);
    expect(h.written).toHaveLength(2); // the big chunk + the flushed tail
  });

  it("drops the held buffer (with a reset notice) past the stall cap", () => {
    const h = harness();
    const m = createWriteMeter(h.write, () => false);
    m.push(chunk(WRITE_HIGH_WATER + 1)); // written, outstanding high
    // Fill the held buffer beyond STALL_CAP so it is dropped + reset.
    m.push(chunk(STALL_CAP));
    m.push(chunk(1)); // this push trips the cap → clears held, marks dropped
    expect(m.held()).toBe(1); // only the latest chunk remains
    h.flushAll();
    // The flush emits the STALL_NOTICE (a reset) before the surviving chunk.
    expect(h.written.some((w) => w.includes("dropped output"))).toBe(true);
  });

  it("stops draining once stale (session disposed)", () => {
    const h = harness();
    let stale = false;
    const m = createWriteMeter(h.write, () => stale);
    m.push(chunk(WRITE_HIGH_WATER + 1));
    m.push(chunk(WRITE_LOW_WATER)); // held
    stale = true;
    h.flushAll();
    // Held bytes are NOT written after going stale.
    expect(m.held()).toBe(WRITE_LOW_WATER);
  });
});
