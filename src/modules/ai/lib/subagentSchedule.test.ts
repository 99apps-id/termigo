import { describe, expect, it } from "vitest";
import {
  cascadeSkip,
  planSubagentBatch,
  readyTasks,
  type TaskState,
} from "./subagentSchedule";

const fresh = (n: number): TaskState[] =>
  Array.from({ length: n }, () => ({
    settled: false,
    bad: false,
    running: false,
  }));

describe("planSubagentBatch", () => {
  it("keeps independent tasks free of dependencies", () => {
    const plan = planSubagentBatch([{}, {}, {}]);
    expect(plan.deps).toEqual([[], [], []]);
    expect(plan.unrunnable).toEqual([]);
  });

  it("keeps a scatter-then-gather shape intact", () => {
    const plan = planSubagentBatch([{}, {}, { depends_on: [0, 1] }]);
    expect(plan.deps).toEqual([[], [], [0, 1]]);
    expect(plan.unrunnable).toEqual([]);
  });

  // A task waiting on itself is never ready, and a scheduler that only waits
  // would spin on it until the process died.
  it("rejects a self-reference", () => {
    const plan = planSubagentBatch([{ depends_on: [0] }]);
    expect(plan.unrunnable).toEqual([
      { index: 0, reason: "depends on itself" },
    ]);
  });

  it("rejects a two-task cycle", () => {
    const plan = planSubagentBatch([
      { depends_on: [1] },
      { depends_on: [0] },
    ]);
    expect(plan.unrunnable.map((u) => u.index)).toEqual([0, 1]);
  });

  it("rejects a longer ring", () => {
    const plan = planSubagentBatch([
      { depends_on: [2] },
      { depends_on: [0] },
      { depends_on: [1] },
    ]);
    expect(plan.unrunnable.map((u) => u.index)).toEqual([0, 1, 2]);
  });

  // The trap in depth-first cycle detection: a node still on the stack from an
  // earlier branch looks like a cycle to a later sibling that also reaches it.
  it("does not mistake a shared dependency for a cycle", () => {
    // 2 and 3 both depend on 0; 4 depends on both. A diamond, not a ring.
    const plan = planSubagentBatch([
      {},
      {},
      { depends_on: [0] },
      { depends_on: [0] },
      { depends_on: [2, 3] },
    ]);
    expect(plan.unrunnable).toEqual([]);
  });

  it("drops an edge pointing at a task that does not exist, and says so", () => {
    const plan = planSubagentBatch([{ depends_on: [7] }, {}]);
    expect(plan.droppedEdges).toEqual([{ index: 0, target: 7 }]);
    // The task still runs; it just runs without that context.
    expect(plan.deps[0]).toEqual([]);
    expect(plan.unrunnable).toEqual([]);
  });

  it("ignores a repeated dependency rather than waiting twice", () => {
    const plan = planSubagentBatch([{}, { depends_on: [0, 0, 0] }]);
    expect(plan.deps[1]).toEqual([0]);
  });
});

describe("readyTasks", () => {
  it("starts every independent task at once, up to the slots", () => {
    const deps = [[], [], []];
    expect(readyTasks(deps, fresh(3), 3)).toEqual([0, 1, 2]);
    expect(readyTasks(deps, fresh(3), 2)).toEqual([0, 1]);
  });

  it("returns nothing when no slots are free", () => {
    expect(readyTasks([[], []], fresh(2), 0)).toEqual([]);
  });

  it("holds a dependent task back until its dependency settles", () => {
    const deps = [[], [0]];
    const state = fresh(2);
    expect(readyTasks(deps, state, 4)).toEqual([0]);

    state[0].running = true;
    expect(readyTasks(deps, state, 4)).toEqual([]);

    state[0] = { settled: true, bad: false, running: false };
    expect(readyTasks(deps, state, 4)).toEqual([1]);
  });

  it("never starts a task whose dependency failed", () => {
    const deps = [[], [0]];
    const state = fresh(2);
    state[0] = { settled: true, bad: true, running: false };
    expect(readyTasks(deps, state, 4)).toEqual([]);
  });
});

describe("cascadeSkip", () => {
  it("skips the direct dependents of a failure", () => {
    const deps = [[], [0], [0]];
    const state = fresh(3);
    state[0] = { settled: true, bad: true, running: false };

    const skipped = cascadeSkip(deps, state, 0);
    expect(skipped.map((s) => s.index)).toEqual([1, 2]);
    expect(state[1].settled && state[1].bad).toBe(true);
  });

  // Transitive: a task depending on a skipped task is just as stuck, and
  // leaving it unsettled is how a batch stops progressing without finishing.
  it("skips dependents of dependents", () => {
    const deps = [[], [0], [1]];
    const state = fresh(3);
    state[0] = { settled: true, bad: true, running: false };

    const skipped = cascadeSkip(deps, state, 0);
    expect(skipped.map((s) => s.index)).toEqual([1, 2]);
    expect(state[2].settled).toBe(true);
  });

  it("leaves unrelated tasks alone", () => {
    const deps = [[], [0], []];
    const state = fresh(3);
    state[0] = { settled: true, bad: true, running: false };

    cascadeSkip(deps, state, 0);
    expect(state[2].settled).toBe(false);
  });

  it("says which dependency caused each skip", () => {
    const deps = [[], [0]];
    const state = fresh(2);
    state[0] = { settled: true, bad: true, running: false };
    expect(cascadeSkip(deps, state, 0)[0].reason).toContain("#0");
  });

  // The whole batch has to reach a settled state, or the caller waits forever.
  it("leaves nothing unsettled in a chain", () => {
    const deps = [[], [0], [1], [2]];
    const state = fresh(4);
    state[0] = { settled: true, bad: true, running: false };
    cascadeSkip(deps, state, 0);
    expect(state.every((s) => s.settled)).toBe(true);
  });
});
