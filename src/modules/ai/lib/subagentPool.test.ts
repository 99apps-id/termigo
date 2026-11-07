import { describe, expect, it } from "vitest";
import {
  MAX_GLOBAL_SUBAGENTS,
  MAX_NESTED_SUBAGENTS_PER_DEPTH,
  SubagentConcurrencyPool,
  globalSubagentPool,
  isSlotAbortError,
  poolForDepth,
  resetNestedPools,
} from "./subagentPool";

describe("SubagentConcurrencyPool", () => {
  it("counts each granted slot exactly once", async () => {
    const pool = new SubagentConcurrencyPool(2);
    const r1 = await pool.acquire();
    const r2 = await pool.acquire();
    expect(pool.activeCount).toBe(2);

    // Third acquire waits; releasing one slot grants it without overshoot.
    const pending = pool.acquire();
    r1();
    const r3 = await pending;
    expect(pool.activeCount).toBe(2);

    r2();
    r3();
    expect(pool.activeCount).toBe(0);
    expect(pool.queueLength).toBe(0);
  });

  it("release is idempotent", async () => {
    const pool = new SubagentConcurrencyPool(1);
    const release = await pool.acquire();
    release();
    release();
    expect(pool.activeCount).toBe(0);
  });

  it("aborting a queued acquire leaves the count untouched", async () => {
    const pool = new SubagentConcurrencyPool(1);
    const held = await pool.acquire();
    const ctrl = new AbortController();
    const pending = pool.acquire(ctrl.signal);
    const assertion = expect(pending).rejects.toThrow(/abort/i);
    ctrl.abort();
    await assertion;
    expect(pool.activeCount).toBe(1);
    expect(pool.queueLength).toBe(0);
    held();
    expect(pool.activeCount).toBe(0);
  });

  it("recognises its own abort rejections", () => {
    expect(
      isSlotAbortError(new Error("Aborted before acquiring subagent slot")),
    ).toBe(true);
    expect(
      isSlotAbortError(new Error("Aborted waiting for subagent slot")),
    ).toBe(true);
    expect(isSlotAbortError(new Error("boom"))).toBe(false);
    expect(isSlotAbortError("Aborted waiting for subagent slot")).toBe(false);
  });
});

describe("poolForDepth", () => {
  it("gives the main agent the global pool", () => {
    resetNestedPools();
    expect(poolForDepth(0)).toBe(globalSubagentPool);
    expect(poolForDepth(-1)).toBe(globalSubagentPool);
    expect(globalSubagentPool.activeCount).toBeLessThanOrEqual(
      MAX_GLOBAL_SUBAGENTS,
    );
  });

  it("gives each nesting depth its own pool", () => {
    resetNestedPools();
    const a = poolForDepth(1);
    const b = poolForDepth(2);
    expect(a).not.toBe(b);
    expect(poolForDepth(1)).toBe(a);
  });

  // The deadlock this replaces: a subagent holds a slot in its parent's pool
  // for its whole run, so queueing its children on that same pool let every
  // parent fill every slot and then block forever on children that could never
  // be admitted. A parent and its children must never share a pool.
  it("lets a saturated parent still run its children", async () => {
    resetNestedPools();
    const parentPool = poolForDepth(1);
    const childPool = poolForDepth(2);
    const held: Array<() => void> = [];
    for (let i = 0; i < MAX_NESTED_SUBAGENTS_PER_DEPTH; i++) {
      held.push(await parentPool.acquire());
    }
    expect(parentPool.activeCount).toBe(MAX_NESTED_SUBAGENTS_PER_DEPTH);

    // Every parent slot is taken, yet a child can still be admitted: it draws
    // from depth 2's pool, not the saturated depth 1 pool.
    const child = await childPool.acquire();
    expect(childPool.activeCount).toBe(1);
    child();
    for (const release of held) release();
    expect(parentPool.activeCount).toBe(0);
    resetNestedPools();
  });
});
