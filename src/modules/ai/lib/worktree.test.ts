import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSandboxes,
  generateSandboxInfo,
  getSandbox,
  listSandboxes,
  registerSandbox,
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
    expect(info.subpath).toBe(".termigo/worktrees/task_123_risky");
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
    const path = ".termigo/worktrees/run-1";
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
      worktreePath: ".termigo/worktrees/run-1",
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
