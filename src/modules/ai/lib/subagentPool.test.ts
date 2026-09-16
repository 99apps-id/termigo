import { describe, expect, it } from "vitest";
import { SubagentConcurrencyPool } from "./subagentPool";

describe("SubagentConcurrencyPool", () => {
  it("limits concurrent acquisitions", async () => {
    const pool = new SubagentConcurrencyPool(2);
    const r1 = await pool.acquire();
    const r2 = await pool.acquire();
    expect(pool.activeCount).toBe(2);
    expect(pool.queueLength).toBe(0);

    let thirdAcquired = false;
    const p3 = pool.acquire().then((r) => {
      thirdAcquired = true;
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdAcquired).toBe(false);
    expect(pool.queueLength).toBe(1);

    r1();
    const release3 = await p3;
    expect(thirdAcquired).toBe(true);
    expect(pool.activeCount).toBe(2);

    r2();
    release3();
    expect(pool.activeCount).toBe(0);
  });

  it("rejects on abort signal", async () => {
    const pool = new SubagentConcurrencyPool(1);
    const r1 = await pool.acquire();
    const ac = new AbortController();

    const p2 = pool.acquire(ac.signal);
    ac.abort();

    await expect(p2).rejects.toThrow("Aborted");
    expect(pool.queueLength).toBe(0);
    r1();
    expect(pool.activeCount).toBe(0);
  });
});
