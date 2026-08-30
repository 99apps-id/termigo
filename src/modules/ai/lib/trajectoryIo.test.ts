import { describe, expect, it } from "vitest";
import type { TrajectoryRun } from "../store/trajectoryStore";
import { mergeRuns } from "./trajectoryIo";

function run(id: string, startedAt = Date.now()): TrajectoryRun {
  return {
    runId: id,
    modelId: "mock",
    startedAt,
    steps: [],
    totalTokens: 0,
    status: "completed",
  };
}

describe("mergeRuns", () => {
  it("upserts a run by id and keeps the newest entries", () => {
    const runs = [run("a"), run("b")];
    const next = mergeRuns(runs, run("a", Date.now() + 1000));
    expect(next.map((r) => r.runId)).toEqual(["b", "a"]);
  });

  it("caps the list at the newest max", () => {
    const runs = [run("a"), run("b"), run("c")];
    const next = mergeRuns(runs, run("d"), 3);
    expect(next.map((r) => r.runId)).toEqual(["b", "c", "d"]);
  });

  it("keeps an updated run's step count", () => {
    const updated: TrajectoryRun = {
      ...run("a"),
      steps: [
        {
          id: "s1",
          stepIndex: 0,
          toolName: "read_file",
          args: {},
          status: "success",
          timestamp: 1,
        },
      ],
    };
    const next = mergeRuns([run("a"), run("b")], updated);
    expect(next.find((r) => r.runId === "a")?.steps).toHaveLength(1);
  });
});
