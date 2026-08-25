import { describe, expect, it } from "vitest";
import { generateSandboxInfo, buildWorktreeCommands } from "../lib/worktree";
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

  it("builds worktree tools properly", () => {
    const ctx = makeContext();
    const tools = buildWorktreeTools(ctx);
    expect(tools.worktree_create).toBeDefined();
    expect(tools.worktree_list).toBeDefined();
    expect(tools.worktree_discard).toBeDefined();
  });
});
