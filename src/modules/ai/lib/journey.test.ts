import { describe, expect, it } from "vitest";
import { buildJourney, relativeTime } from "./journey";
import type { CheckpointEntry } from "./snapshots";
import type { TrajectoryRun, TrajectoryStep } from "../store/trajectoryStore";

function step(
  id: string,
  toolName: string,
  timestamp: number,
  status: TrajectoryStep["status"] = "success",
): TrajectoryStep {
  return { id, stepIndex: 0, toolName, args: {}, status, timestamp };
}

function checkpoint(label: string, timestampSecs: number): CheckpointEntry {
  return { sha: "a".repeat(7), shortSha: "aaaaaaa", label, timestampSecs };
}

describe("buildJourney", () => {
  const run: Pick<TrajectoryRun, "startedAt" | "finishedAt" | "steps"> = {
    startedAt: 1_000,
    finishedAt: 10_000,
    steps: [
      step("s1", "read_file", 2_000),
      step("s2", "edit", 6_000),
    ],
  };

  it("interleaves steps and in-window checkpoints chronologically", () => {
    const events = buildJourney(run, [checkpoint("safe point", 4)]); // ms 4000
    expect(events.map((e) => e.kind)).toEqual(["step", "checkpoint", "step"]);
    expect(events.map((e) => e.at)).toEqual([2_000, 4_000, 6_000]);
  });

  it("drops checkpoints outside the run window", () => {
    const events = buildJourney(run, [
      checkpoint("before", 0), // ms 0, before start
      checkpoint("after", 100), // ms 100000, after finish
      checkpoint("within", 5), // ms 5000, within
    ]);
    const cps = events.filter((e) => e.kind === "checkpoint");
    expect(cps).toHaveLength(1);
    expect(cps[0].kind === "checkpoint" && cps[0].checkpoint.label).toBe(
      "within",
    );
  });

  it("sorts by timestamp", () => {
    const events = buildJourney(run, [checkpoint("z", 7), checkpoint("a", 3)]);
    const ats = events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });
});

describe("relativeTime", () => {
  const now = 100_000;
  it("formats durations", () => {
    expect(relativeTime(now, now)).toBe("now");
    expect(relativeTime(now - 5000, now)).toBe("5s");
    expect(relativeTime(now - 120_000, now)).toBe("2m");
    expect(relativeTime(now - 3_600_000, now)).toBe("1h");
  });
});
