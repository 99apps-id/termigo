import { describe, expect, it } from "vitest";
import {
  gitBlameCommand,
  gitDiffCommand,
  gitLogCommand,
  gitPullCommand,
  gitPushCommand,
  gitShowCommand,
  gitStashCommand,
  gitStashPopCommand,
  gitStatusCommand,
  repoRootFor,
  revertCommand,
  validBranch,
} from "./git";

describe("validBranch", () => {
  it("accepts conventional branch names", () => {
    for (const name of [
      "feat/user-auth",
      "fix/crash-on-mount",
      "docs/readme",
      "chore_2.0",
      "release-1.0.0",
      "hotfix/login.bug",
    ]) {
      expect(validBranch(name)).toBe(true);
    }
  });

  it("rejects option-like, empty and control-bearing names", () => {
    for (const name of [
      "",
      "-rf",
      "feature x",
      "feat\nuser",
      "a:b",
      "b?ranch",
      "a^b",
      "a~b",
      "a*b",
      "a[1]",
      "a\\b",
    ]) {
      expect(validBranch(name)).toBe(false);
    }
  });
});

describe("git command builders", () => {
  it("builds a concise status command", () => {
    expect(gitStatusCommand()).toBe("git status --short --branch");
  });

  it("resolves git cwd from the workspace root first, then the terminal cwd", () => {
    // A project operation must stay on the repo even when the active terminal
    // is elsewhere (home, a subdir, another repo) - BatikCode parity.
    expect(repoRootFor("/repo", "/home")).toBe("/repo");
    expect(repoRootFor("/repo", null)).toBe("/repo");
    expect(repoRootFor(null, "/cwd")).toBe("/cwd");
    expect(repoRootFor(null, null)).toBe(".");
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

  it("builds a fast-forward pull command", () => {
    expect(gitPullCommand()).toBe("git pull --ff-only");
  });

  it("builds stash push/pop commands", () => {
    expect(gitStashCommand(undefined)).toBe("git stash push");
    expect(gitStashCommand("wip: auth")).toBe("git stash push -m 'wip: auth'");
    expect(gitStashPopCommand()).toBe("git stash pop");
  });

  it("builds a blame command with optional line range and path", () => {
    expect(gitBlameCommand({ path: "src/App.tsx" })).toBe(
      "git blame --line-porcelain -- 'src/App.tsx'",
    );
    expect(gitBlameCommand({ path: "src/App.tsx", lines: "5-20" })).toBe(
      "git blame --line-porcelain -L 5-20 -- 'src/App.tsx'",
    );
    expect(gitBlameCommand({})).toBe("git blame --line-porcelain");
  });

  it("builds a show command with stat by default and full diff on request", () => {
    expect(gitShowCommand({})).toBe("git show --format=fuller --stat 'HEAD'");
    expect(gitShowCommand({ ref: "abc1234" })).toBe(
      "git show --format=fuller --stat 'abc1234'",
    );
    expect(gitShowCommand({ ref: "abc1234", statOnly: true })).toBe(
      "git show --format=fuller --stat 'abc1234'",
    );
    expect(gitShowCommand({ ref: "HEAD~2", statOnly: false })).toBe(
      "git show --format=fuller 'HEAD~2'",
    );
    expect(
      gitShowCommand({ ref: "abc", path: "src/App.tsx", statOnly: true }),
    ).toBe("git show --format=fuller --stat 'abc' -- 'src/App.tsx'");
  });
});
