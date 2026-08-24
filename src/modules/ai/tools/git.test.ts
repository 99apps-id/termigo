import { describe, expect, it } from "vitest";
import {
  gitDiffCommand,
  gitLogCommand,
  gitPushCommand,
  gitStatusCommand,
  revertCommand,
  validBranch,
} from "./git";

describe("validBranch", () => {
  it("accepts conventional branch names", () => {
    for (const name of ["feat/user-auth", "fix/crash-on-mount", "docs/readme", "chore_2.0", "release-1.0.0", "hotfix/login.bug"]) {
      expect(validBranch(name)).toBe(true);
    }
  });

  it("rejects option-like, empty and control-bearing names", () => {
    for (const name of ["", "-rf", "feature x", "feat\nuser", "a:b", "b?ranch", "a^b", "a~b", "a*b", "a[1]", "a\\b"]) {
      expect(validBranch(name)).toBe(false);
    }
  });
});

describe("git command builders", () => {
  it("builds a concise status command", () => {
    expect(gitStatusCommand()).toBe("git status --short --branch");
  });

  it("builds a plain diff, a staged diff, and a path-scoped diff", () => {
    expect(gitDiffCommand({})).toBe("git diff");
    expect(gitDiffCommand({ staged: true })).toBe("git diff --staged");
    expect(gitDiffCommand({ path: "src/App.tsx" })).toBe(
      "git diff -- 'src/App.tsx'",
    );
  });

  it("builds a revert command, scoped or global, with quoting", () => {
    expect(revertCommand(["src/App.tsx"])).toBe("git restore -- 'src/App.tsx'");
    expect(revertCommand(["a", "b"]).trim()).toBe("git restore -- 'a' 'b'");
    expect(revertCommand(undefined)).toBe("git restore .");
  });

  it("builds push and bounded log commands", () => {
    expect(gitPushCommand()).toBe("git push");
    expect(gitLogCommand(20)).toBe("git log --oneline -n 20");
    // Clamps an out-of-range limit.
    expect(gitLogCommand(999)).toBe("git log --oneline -n 200");
    expect(gitLogCommand(0)).toBe("git log --oneline -n 1");
  });
});
