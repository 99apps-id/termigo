import { describe, expect, it } from "vitest";
import type { ToolContext } from "../tools/context";
import {
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

describe("rerootToolContext", () => {
  const ctx = {
    getCwd: () => "/repo/sub",
    getWorkspaceRoot: () => "/repo",
    getRemoteSession: () => ({ sessionId: 7, cwd: "/remote" }),
    getTerminalContext: () => "terminal output",
    isActiveTerminalPrivate: () => false,
    listTerminals: () => [{ tabId: 1 }],
    getTerminalContextFor: () => "other terminal",
    injectIntoActivePty: () => true,
    openPreview: () => true,
    openCanvas: () => true,
    browserExtract: async () => ({ text: "parent page" }),
    browserScreenshot: async () => ({ screenshot: "png-bytes" }),
    browserList: async () => ["main"],
    readAgentOutput: () => "parent agent output",
  } as unknown as ToolContext;

  it("moves both filesystem roots into the worktree", () => {
    const rooted = rerootToolContext(ctx, "/repo/.wt/abc");
    expect(rooted.getCwd()).toBe("/repo/.wt/abc");
    expect(rooted.getWorkspaceRoot()).toBe("/repo/.wt/abc");
  });

  // Isolation is more than a filesystem boundary. The subagent must not be able
  // to observe or steer the parent's live session: its terminal buffer, its
  // browser pages, or another agent's output are all context the worktree says
  // nothing about, and leaking them defeats the point of isolating the run.
  it("blinds the terminal surface", () => {
    const rooted = rerootToolContext(ctx, "/repo/.wt/abc");
    expect(rooted.getTerminalContext()).toBeNull();
    expect(rooted.isActiveTerminalPrivate()).toBe(true);
    expect(rooted.listTerminals()).toEqual([]);
    expect(rooted.getTerminalContextFor(1)).toBeNull();
    expect(rooted.injectIntoActivePty("ls")).toBe(false);
  });

  it("blinds the browser and preview surface", async () => {
    const rooted = rerootToolContext(ctx, "/repo/.wt/abc");
    expect(rooted.openPreview("http://x")).toBe(false);
    expect(rooted.openCanvas("<p>x</p>")).toBe(false);
    expect(await rooted.browserExtract("main")).toEqual({
      error: "not available in isolated subagent",
    });
    expect(await rooted.browserScreenshot("main")).toEqual({
      error: "not available in isolated subagent",
    });
    expect(await rooted.browserList()).toEqual([]);
  });

  it("blinds agent-output reads and the remote session", () => {
    const rooted = rerootToolContext(ctx, "/repo/.wt/abc");
    expect(rooted.readAgentOutput(1)).toBeNull();
    expect(rooted.getRemoteSession()).toBeNull();
  });

  it("does not mutate the context it was given", () => {
    rerootToolContext(ctx, "/repo/.wt/abc");
    expect(ctx.getCwd()).toBe("/repo/sub");
    expect(ctx.getWorkspaceRoot()).toBe("/repo");
    expect(ctx.getTerminalContext()).toBe("terminal output");
  });
});

describe("worktreeRelativePath", () => {
  it("places the worktree under the workspace, where .wt is ignored", () => {
    expect(worktreeRelativePath("abc123")).toBe(".wt/abc123");
  });
});
