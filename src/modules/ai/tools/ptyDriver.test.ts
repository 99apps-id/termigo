import { describe, expect, it } from "vitest";
import type { ToolContext } from "./context";
import { buildPtyDriverTools } from "./ptyDriver";

function makeContext(
  buffer: string | null = "Ready on http://localhost:3000\n",
): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => buffer,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => true,
    openPreview: () => false,
    openCanvas: () => false,
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

describe("ptyDriver tools", () => {
  it("reads terminal buffer slice correctly", async () => {
    const ctx = makeContext("line 1\nline 2\nline 3");
    const tools = buildPtyDriverTools(ctx);

    const exec = tools.pty_read_screen.execute;
    if (!exec) throw new Error("pty_read_screen execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ max_lines: 2 }, {} as any)) as any;
    expect(res.lines_returned).toBe(2);
    expect(res.buffer).toBe("line 2\nline 3");
  });

  it("checks patterns in terminal stream accurately", async () => {
    const ctx = makeContext("Server started on port 8080");
    const tools = buildPtyDriverTools(ctx);

    const exec = tools.pty_wait_for_pattern.execute;
    if (!exec) throw new Error("pty_wait_for_pattern execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const found = (await exec({ pattern: "port 8080" }, {} as any)) as any;
    expect(found.found).toBe(true);

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const notFound = (await exec({ pattern: "port 3000" }, {} as any)) as any;
    expect(notFound.found).toBe(false);
  });

  it("returns a tool error rather than throwing for an invalid regex", async () => {
    const tools = buildPtyDriverTools(makeContext());
    const exec = tools.pty_wait_for_pattern.execute;
    if (!exec) throw new Error("pty_wait_for_pattern execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const result = (await exec({ pattern: "(" }, {} as any)) as any;
    expect(result.found).toBe(false);
    expect(result.error).toMatch(/invalid regex/i);
  });
});
