import { describe, expect, it } from "vitest";
import { buildPtyDriverTools } from "./ptyDriver";
import type { ToolContext } from "./context";

function makeContext(buffer: string | null = "Ready on http://localhost:3000\n"): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => buffer,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => true,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
  };
}

describe("ptyDriver tools", () => {
  it("reads terminal buffer slice correctly", async () => {
    const ctx = makeContext("line 1\nline 2\nline 3");
    const tools = buildPtyDriverTools(ctx);

    const exec = tools.pty_read_screen.execute;
    if (!exec) throw new Error("pty_read_screen execute missing");

    const res = (await exec({ max_lines: 2 }, {} as any)) as any;
    expect(res.lines_returned).toBe(2);
    expect(res.buffer).toBe("line 2\nline 3");
  });

  it("checks patterns in terminal stream accurately", async () => {
    const ctx = makeContext("Server started on port 8080");
    const tools = buildPtyDriverTools(ctx);

    const exec = tools.pty_wait_for_pattern.execute;
    if (!exec) throw new Error("pty_wait_for_pattern execute missing");

    const found = (await exec({ pattern: "port 8080" }, {} as any)) as any;
    expect(found.found).toBe(true);

    const notFound = (await exec({ pattern: "port 3000" }, {} as any)) as any;
    expect(notFound.found).toBe(false);
  });
});
