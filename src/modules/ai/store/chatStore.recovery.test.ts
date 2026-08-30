import { describe, expect, it } from "vitest";
import type { RunMeta } from "../lib/sessions";
import { runInterruptedPatch } from "./chatStore";

const meta = (over: Partial<RunMeta>): RunMeta => ({
  runRound: 0,
  stopReason: null,
  stoppedByUser: false,
  at: 1,
  ...over,
});

describe("runInterruptedPatch (restart recovery)", () => {
  it("restores a deliberate stop so the transcript offers Continue", () => {
    expect(runInterruptedPatch(meta({ stoppedByUser: true }), null)).toEqual({
      runRound: 0,
      stopReason: null,
      stoppedByUser: true,
    });
  });

  it("restores a guard stop (step-cap) with its runRound ladder", () => {
    expect(
      runInterruptedPatch(meta({ runRound: 2, stopReason: "step-cap" }), null),
    ).toEqual({
      runRound: 2,
      stopReason: "step-cap",
      stoppedByUser: false,
    });
  });

  it("treats a no-stop RunMeta with an in-flight marker as interrupted", () => {
    expect(runInterruptedPatch(meta({}), 1234)).toEqual({
      runRound: 0,
      stopReason: "interrupted",
      stoppedByUser: false,
    });
  });

  it("treats a stale in-flight marker with no RunMeta as interrupted", () => {
    expect(runInterruptedPatch(null, 1234)).toEqual({
      stopReason: "interrupted",
      stoppedByUser: false,
    });
  });

  it("returns null when nothing was left mid-run", () => {
    expect(runInterruptedPatch(null, null)).toBeNull();
    expect(runInterruptedPatch(meta({}), null)).toBeNull();
  });
});
