import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./native", () => ({
  native: {
    runCommand: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      truncated: false,
    })),
  },
}));

import { native } from "./native";
import {
  clearSandboxes,
  cleanupStaleSandboxes,
  generateSandboxInfo,
  getSandbox,
  listSandboxes,
  registerSandbox,
  repoRootOfWorktree,
  unregisterSandbox,
  worktreeAddCommand,
  worktreeDeleteBranchCommand,
  worktreeDiffCommand,
  worktreeDiffStatCommand,
  worktreeMergeCommand,
  worktreeRemoveCommand,
} from "./worktree";

describe("worktree isolation library", () => {
  beforeEach(() => {
    clearSandboxes();
  });

  it("generates sanitized unique sandbox identifiers", () => {
    const info = generateSandboxInfo("task/123:risky");
    expect(info.id).toBe("task_123_risky");
    expect(info.branchName).toBe("termigo-sandbox/task_123_risky");
    expect(info.subpath).toBe(".wt/task_123_risky");
  });

  it("handles empty or special character taskIds gracefully", () => {
    const emptyInfo = generateSandboxInfo("");
    expect(emptyInfo.id.length).toBeGreaterThan(0);
    expect(emptyInfo.branchName).toMatch(/^termigo-sandbox\/[a-zA-Z0-9_-]+$/);

    const specialInfo = generateSandboxInfo("///");
    expect(specialInfo.id.length).toBeGreaterThan(0);
    expect(specialInfo.branchName).toMatch(/^termigo-sandbox\/[a-zA-Z0-9_-]+$/);
  });

  it("constructs safely quoted shell commands", () => {
    const path = ".wt/run-1";
    const branch = "termigo-sandbox/run-1";

    const addCmd = worktreeAddCommand(path, branch);
    expect(addCmd).toBe(`git worktree add -b '${branch}' '${path}' HEAD`);

    const diffCmd = worktreeDiffCommand(path);
    expect(diffCmd).toBe(`git -C '${path}' diff 'HEAD'`);

    const statCmd = worktreeDiffStatCommand(path);
    expect(statCmd).toBe(`git -C '${path}' diff --stat 'HEAD'`);

    const mergeCmd = worktreeMergeCommand(branch, false);
    expect(mergeCmd).toBe(`git merge '${branch}'`);

    const squashMergeCmd = worktreeMergeCommand(branch, true);
    expect(squashMergeCmd).toBe(`git merge --squash '${branch}'`);

    const removeCmd = worktreeRemoveCommand(path);
    expect(removeCmd).toBe(`git worktree remove --force '${path}'`);

    const delBranchCmd = worktreeDeleteBranchCommand(branch);
    expect(delBranchCmd).toBe(`git branch -D '${branch}'`);
  });

  it("registers, lists, and unregisters active sandboxes", () => {
    expect(listSandboxes()).toHaveLength(0);

    const s1 = {
      id: "run-1",
      branchName: "termigo-sandbox/run-1",
      worktreePath: ".wt/run-1",
      createdAt: Date.now(),
      status: "active" as const,
      description: "Experimenting with refactor",
    };

    registerSandbox(s1);
    expect(listSandboxes()).toHaveLength(1);
    expect(getSandbox("run-1")).toEqual(s1);

    unregisterSandbox("run-1", "merged");
    expect(listSandboxes()).toHaveLength(0);
    expect(s1.status).toBe("merged");
  });
});

describe("repoRootOfWorktree", () => {
  it("derives the repo root from the .wt layout (posix)", () => {
    expect(repoRootOfWorktree("/repo/.wt/abc123")).toBe("/repo");
    expect(repoRootOfWorktree("/home/u/proj/.wt/x/y")).toBe("/home/u/proj");
  });

  it("derives the repo root from windows separators", () => {
    expect(repoRootOfWorktree("C:\\project\\app\\.wt\\abc123")).toBe(
      "C:/project/app",
    );
  });

  it("returns null when the path is not a .wt worktree", () => {
    expect(repoRootOfWorktree("/repo/src")).toBeNull();
    expect(repoRootOfWorktree("/.wt/orphan")).toBeNull();
  });
});

describe("cleanupStaleSandboxes", () => {
  beforeEach(() => {
    clearSandboxes();
    vi.mocked(native.runCommand).mockClear();
  });

  const DAY = 24 * 60 * 60 * 1000;

  it("removes only sandboxes older than seven days", async () => {
    registerSandbox({
      id: "old",
      branchName: "termigo-sandbox/old",
      worktreePath: "/repo/.wt/old",
      createdAt: Date.now() - 8 * DAY,
      status: "active",
    });
    registerSandbox({
      id: "fresh",
      branchName: "termigo-sandbox/fresh",
      worktreePath: "/repo/.wt/fresh",
      createdAt: Date.now(),
      status: "active",
    });

    await cleanupStaleSandboxes();

    expect(getSandbox("old")).toBeUndefined();
    expect(getSandbox("fresh")).toBeDefined();

    // Worktree removal and branch deletion, both run from the main repo root
    // (git refuses to remove the worktree you are standing in).
    const calls = vi.mocked(native.runCommand).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toContain("worktree remove --force");
    expect(calls[0][1]).toBe("/repo");
    expect(calls[1][0]).toContain("branch -D");
    expect(calls[1][1]).toBe("/repo");
  });

  it("is a no-op when nothing is stale", async () => {
    registerSandbox({
      id: "fresh",
      branchName: "termigo-sandbox/fresh",
      worktreePath: "/repo/.wt/fresh",
      createdAt: Date.now(),
      status: "active",
    });
    await cleanupStaleSandboxes();
    expect(native.runCommand).not.toHaveBeenCalled();
    expect(getSandbox("fresh")).toBeDefined();
  });
});
