import { describe, expect, it } from "vitest";
import type { ToolContext } from "../tools/context";
import {
  defaultBatchIsolation,
  planSubagentIsolation,
  rerootToolContext,
  worktreeRelativePath,
} from "./subagentIsolation";

const base = {
  requested: true,
  isReadOnly: false,
  hasRemoteSession: false,
  workspaceRoot: "/repo",
};

describe("planSubagentIsolation", () => {
  it("isolates a writing subagent when asked", () => {
    expect(planSubagentIsolation(base)).toEqual({ isolate: true });
  });

  // The whole point of making it opt-in: nothing changes for existing callers.
  it("does nothing unless the caller asks", () => {
    const plan = planSubagentIsolation({ ...base, requested: false });
    expect(plan.isolate).toBe(false);
    if (!plan.isolate) expect(plan.reason).toContain("not requested");
  });

  // A read-only agent gains nothing from a copy and could read it stale.
  it("never isolates a read-only subagent", () => {
    const plan = planSubagentIsolation({ ...base, isReadOnly: true });
    expect(plan.isolate).toBe(false);
    if (!plan.isolate) expect(plan.reason).toContain("read-only");
  });

  // A local worktree of a remote project would be empty, and the agent's writes
  // would go somewhere the user never sees.
  it("refuses to isolate across an SSH session", () => {
    const plan = planSubagentIsolation({ ...base, hasRemoteSession: true });
    expect(plan.isolate).toBe(false);
    if (!plan.isolate) expect(plan.reason).toContain("remote");
  });

  it("refuses when there is no workspace root to branch from", () => {
    const plan = planSubagentIsolation({ ...base, workspaceRoot: null });
    expect(plan.isolate).toBe(false);
    if (!plan.isolate) expect(plan.reason).toContain("workspace root");
  });

  it("gives a reason for every refusal, so a silent no-op is impossible", () => {
    const refusals = [
      { ...base, requested: false },
      { ...base, isReadOnly: true },
      { ...base, hasRemoteSession: true },
      { ...base, workspaceRoot: null },
    ];
    for (const input of refusals) {
      const plan = planSubagentIsolation(input);
      expect(plan.isolate).toBe(false);
      if (!plan.isolate) expect(plan.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("defaultBatchIsolation", () => {
  // A lone writer keeps the long-standing shared-tree behaviour: auto-isolating
  // it would strand its work in a worktree the caller never asked for.
  it("stays off for zero or one writer", () => {
    expect(defaultBatchIsolation(0)).toBe(false);
    expect(defaultBatchIsolation(1)).toBe(false);
  });

  // Two writers branching from the same baseline is exactly the collision this
  // module exists to prevent, so it turns on by itself.
  it("turns on at two or more writers", () => {
    expect(defaultBatchIsolation(2)).toBe(true);
    expect(defaultBatchIsolation(8)).toBe(true);
  });
});

describe("rerootToolContext", () => {
  const ctx = {
    getCwd: () => "/repo/sub",
    getWorkspaceRoot: () => "/repo",
    getTerminalContext: () => "terminal output",
    isActiveTerminalPrivate: () => false,
  } as unknown as ToolContext;

  it("moves both filesystem roots into the worktree", () => {
    const rooted = rerootToolContext(ctx, "/repo/.termigo/worktrees/abc");
    expect(rooted.getCwd()).toBe("/repo/.termigo/worktrees/abc");
    expect(rooted.getWorkspaceRoot()).toBe("/repo/.termigo/worktrees/abc");
  });

  // Only the roots move. The subagent is the same process in the same session,
  // so the terminal, browser and control plane must keep working as before.
  it("leaves everything that is not a filesystem root alone", () => {
    const rooted = rerootToolContext(ctx, "/repo/.termigo/worktrees/abc");
    expect(rooted.getTerminalContext()).toBe("terminal output");
    expect(rooted.isActiveTerminalPrivate()).toBe(false);
  });

  it("does not mutate the context it was given", () => {
    rerootToolContext(ctx, "/repo/.termigo/worktrees/abc");
    expect(ctx.getCwd()).toBe("/repo/sub");
    expect(ctx.getWorkspaceRoot()).toBe("/repo");
  });
});

describe("worktreeRelativePath", () => {
  it("places the worktree under the workspace, where .termigo is ignored", () => {
    expect(worktreeRelativePath("abc123")).toBe(".termigo/worktrees/abc123");
  });
});
