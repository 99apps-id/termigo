import { describe, expect, it } from "vitest";
import { SubagentConcurrencyPool } from "./subagentPool";

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
});
