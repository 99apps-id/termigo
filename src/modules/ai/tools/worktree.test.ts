import { describe, expect, it } from "vitest";
import {
  generateSandboxInfo,
  buildWorktreeCommands,
  worktreeAddCommand,
  worktreeRemoveCommand,
  worktreeDeleteBranchCommand,
} from "../lib/worktree";
import { buildWorktreeTools } from "./worktree";
import type { ToolContext } from "./context";

function makeContext(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    browserOpen: async () => ({ error: "browser bridge unavailable" }),
    browserNavigate: async () => ({ error: "browser bridge unavailable" }),
    browserBack: async () => ({ error: "browser bridge unavailable" }),
    browserForward: async () => ({ error: "browser bridge unavailable" }),
    browserReload: async () => ({ error: "browser bridge unavailable" }),
    browserExtract: async () => ({ error: "browser bridge unavailable" }),
    browserEval: async () => ({ error: "browser bridge unavailable" }),
    browserScreenshot: async () => ({ error: "browser bridge unavailable" }),
    browserConsole: async () => ({ error: "browser bridge unavailable" }),
    browserUrl: async () => ({ error: "browser bridge unavailable" }),
    browserClose: async () => ({ error: "browser bridge unavailable" }),
    browserList: async () => [],
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
  };
}

describe("worktree isolation", () => {
  it("generates correct sandbox info and sanitized branch names", () => {
    const info = generateSandboxInfo("fix/bug-123");
    expect(info.id).toBe("fix_bug-123");
    expect(info.branchName).toBe("termigo-sandbox/fix_bug-123");
    expect(info.subpath).toBe(".termigo/worktrees/fix_bug-123");
  });

  it("builds correct git worktree commands", () => {
    const cmds = buildWorktreeCommands({
      worktreePath: ".termigo/worktrees/task-1",
      branchName: "termigo-sandbox/task-1",
    });

    expect(cmds.add).toEqual(["worktree", "add", "-b", "termigo-sandbox/task-1", ".termigo/worktrees/task-1", "HEAD"]);
    expect(cmds.remove).toEqual(["worktree", "remove", "--force", ".termigo/worktrees/task-1"]);
    expect(cmds.deleteBranch).toEqual(["branch", "-D", "termigo-sandbox/task-1"]);
  });

  it("builds quoted shell commands for worktree operations", () => {
    const add = worktreeAddCommand(".termigo/worktrees/task 1", "termigo-sandbox/task 1");
    expect(add).toBe(
      "git worktree add -b 'termigo-sandbox/task 1' '.termigo/worktrees/task 1' HEAD",
    );

    const remove = worktreeRemoveCommand(".termigo/worktrees/task-1");
    expect(remove).toBe("git worktree remove --force '.termigo/worktrees/task-1'");

    const del = worktreeDeleteBranchCommand("termigo-sandbox/task-1");
    expect(del).toBe("git branch -D 'termigo-sandbox/task-1'");
  });

  it("builds worktree tools properly", () => {
    const ctx = makeContext();
    const tools = buildWorktreeTools(ctx);
    expect(tools.worktree_create).toBeDefined();
    expect(tools.worktree_list).toBeDefined();
    expect(tools.worktree_discard).toBeDefined();
  });
});
