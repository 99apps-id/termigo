import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_MESSAGE,
  type PersistedRunLike,
  reconcileInterruptedRuns,
  reconcileInterruptedSessions,
} from "./subagentRunReconcile";

const NOW = 1_700_000_000_000;

// Annotated as PersistedRunLike on purpose: `reconcileInterruptedRuns` is
// generic over the row type, so a bare literal like `{ id, status, startedAt }`
// infers a T WITHOUT `error`/`endedAt`/`durationMs` and the assertions below
// do not type-check - even though the function fills those fields in at
// runtime. The annotation is what the real persisted rows satisfy.
type TestRun = PersistedRunLike & { id: number };

const running = (id: number, startedAt = NOW - 60_000): TestRun => ({
  id,
  status: "running",
  startedAt,
});
const done = (id: number): TestRun => ({ id, status: "done", endedAt: NOW - 1000 });
const errored = (id: number, error = "boom"): TestRun => ({
  id,
  status: "error",
  endedAt: NOW - 1000,
  error,
});

describe("reconcileInterruptedRuns", () => {
  // The defect: a row persisted as `running` describes a run that died with the
  // previous process, and it was restored verbatim - so the UI showed a subagent
  // that finished an hour ago as still working.
  it("settles a running row read back from disk", () => {
    const { runs, settled } = reconcileInterruptedRuns([running(1)], NOW);

    expect(settled).toBe(1);
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.error).toBe(INTERRUPTED_MESSAGE);
    expect(runs[0]?.endedAt).toBe(NOW);
  });

  it("fills in timestamps so the row stops measuring as in-flight", () => {
    const { runs } = reconcileInterruptedRuns([running(1, NOW - 30_000)], NOW);
    expect(runs[0]?.endedAt).toBe(NOW);
    expect(runs[0]?.durationMs).toBe(30_000);
  });

  // A clock that moved backwards must not yield a negative duration.
  it("never records a negative duration", () => {
    const { runs } = reconcileInterruptedRuns([running(1, NOW + 5_000)], NOW);
    expect(runs[0]?.durationMs).toBe(0);
    expect(runs[0]?.endedAt).toBe(NOW + 5_000);
  });

  it("copes with a row that has no start time", () => {
    const { runs } = reconcileInterruptedRuns<TestRun>(
      [{ id: 1, status: "running" }],
      NOW,
    );
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.durationMs).toBe(0);
  });

  // Terminal rows carry the result of real work; rewriting them would destroy
  // history rather than repair it.
  it("leaves finished and failed rows exactly as they were", () => {
    const finished = [done(1), errored(2)];
    const { runs, settled } = reconcileInterruptedRuns(finished, NOW);

    expect(settled).toBe(0);
    expect(runs).toEqual(finished);
  });

  it("keeps every row, including the ones it settles", () => {
    const { runs } = reconcileInterruptedRuns([done(1), running(2), errored(3)], NOW);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  // After settling, the eviction guard stops protecting the row, so the history
  // cap works again - that guard protects `running` rows on purpose.
  it("produces rows the eviction guard will no longer protect", () => {
    const { runs } = reconcileInterruptedRuns([running(1)], NOW);
    expect(runs.some((r) => r.status === "running")).toBe(false);
  });

  it("does nothing to an empty list", () => {
    const { runs, settled } = reconcileInterruptedRuns([], NOW);
    expect(runs).toEqual([]);
    expect(settled).toBe(0);
  });
});

describe("reconcileInterruptedSessions", () => {
  it("settles runs across every session", () => {
    const { bySession, settled } = reconcileInterruptedSessions(
      { a: [running(1)], b: [running(2), done(3)] },
      NOW,
    );

    expect(settled).toBe(2);
    expect(bySession.a?.[0]?.status).toBe("error");
    expect(bySession.b?.[0]?.status).toBe("error");
    expect(bySession.b?.[1]?.status).toBe("done");
  });

  // Returning the SAME reference when nothing changed lets the caller skip a
  // state write, which would otherwise persist identical data on every start.
  it("returns the input untouched when there is nothing to settle", () => {
    const input = { a: [done(1)], b: [errored(2)] };
    const { bySession, settled } = reconcileInterruptedSessions(input, NOW);

    expect(settled).toBe(0);
    expect(bySession).toBe(input);
  });

  it("handles an empty store", () => {
    const input: Record<string, never[]> = {};
    const { bySession, settled } = reconcileInterruptedSessions(input, NOW);
    expect(settled).toBe(0);
    expect(bySession).toBe(input);
  });

  it("survives a session whose value is missing", () => {
    const { settled } = reconcileInterruptedSessions(
      { a: undefined as unknown as { status: string }[] },
      NOW,
    );
    expect(settled).toBe(0);
  });
});
