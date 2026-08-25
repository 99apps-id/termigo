import { describe, expect, it } from "vitest";
import type { GitLogEntry } from "./native";
import {
  checkpointAddCommand,
  checkpointCommitCommand,
  checkpointLabel,
  checkpointsFromLog,
  isCheckpointSubject,
  isValidSha,
  rollbackResetCommand,
} from "./snapshots";

function logEntry(overrides: Partial<GitLogEntry>): GitLogEntry {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    author: "Iwan",
    authorEmail: "iwan@example.com",
    timestampSecs: 1_700_000_000,
    parents: [],
    subject: "checkpoint: auto before run",
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    ...overrides,
  };
}

describe("isValidSha", () => {
  it("accepts full and abbreviated object ids", () => {
    expect(isValidSha("a".repeat(40))).toBe(true);
    expect(isValidSha("abc1234")).toBe(true);
    expect(isValidSha("ABC1234")).toBe(true);
  });

  it("rejects anything that is not a hex object id", () => {
    expect(isValidSha("")).toBe(false);
    expect(isValidSha("abc123")).toBe(false); // too short
    expect(isValidSha("a".repeat(41))).toBe(false); // too long
    expect(isValidSha("not-a-sha")).toBe(false);
    expect(isValidSha("zzz1234")).toBe(false); // not hex
    expect(isValidSha("main")).toBe(false);
  });
});

describe("checkpoint subject helpers", () => {
  it("recognizes checkpoint subjects", () => {
    expect(isCheckpointSubject("checkpoint: auto before run")).toBe(true);
    expect(isCheckpointSubject("checkpoint:manual")).toBe(true);
    expect(isCheckpointSubject("feat: checkpoint: not one")).toBe(false);
    expect(isCheckpointSubject("feat: add checkpoint")).toBe(false);
  });

  it("extracts the label after the prefix", () => {
    expect(checkpointLabel("checkpoint: auto before run")).toBe(
      "auto before run",
    );
    expect(checkpointLabel("checkpoint:manual")).toBe("manual");
    expect(checkpointLabel("checkpoint:")).toBe("");
  });
});

describe("command builders", () => {
  it("stages everything including untracked files", () => {
    expect(checkpointAddCommand()).toBe("git add -A");
  });

  it("builds the commit command with the checkpoint prefix", () => {
    const cmd = checkpointCommitCommand("auto before run");
    expect(cmd).toContain("git commit -m");
    expect(cmd).toContain("checkpoint: auto before run");
  });

  it("falls back to a default label for empty input", () => {
    expect(checkpointCommitCommand("   ")).toContain("checkpoint: checkpoint");
  });

  it("builds a hard reset for rollback", () => {
    expect(rollbackResetCommand("abc1234")).toBe("git reset --hard 'abc1234'");
  });
});

describe("checkpointsFromLog", () => {
  it("keeps only checkpoint commits and preserves order", () => {
    const entries = [
      logEntry({ sha: "c".repeat(40), shortSha: "ccccccc", subject: "feat: something" }),
      logEntry({ sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "checkpoint: auto before run" }),
      logEntry({ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "checkpoint: manual save" }),
    ];
    const checkpoints = checkpointsFromLog(entries);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].shortSha).toBe("bbbbbbb");
    expect(checkpoints[0].label).toBe("auto before run");
    expect(checkpoints[1].label).toBe("manual save");
  });

  it("returns an empty list when there are no checkpoints", () => {
    expect(checkpointsFromLog([logEntry({ subject: "feat: x" })])).toEqual([]);
    expect(checkpointsFromLog([])).toEqual([]);
  });
});
