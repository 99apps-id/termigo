import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";
import { buildPtyDriverTools } from "./ptyDriver";

function makeContext(
  buffer: string | null = "Ready on http://localhost:3000\n",
  opts?: { private?: boolean },
): ToolContext {
  const getTerminalContext = vi.fn(() => buffer);
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext,
    isActiveTerminalPrivate: () => opts?.private ?? false,
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

  it("pty_session executes read action and returns buffer", async () => {
    const ctx = makeContext("first line\nsecond line\nthird line");
    const tools = buildPtyDriverTools(ctx);
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ action: "read", max_lines: 2 }, {} as any)) as any;
    expect(res.action).toBe("read");
    expect(res.lines_returned).toBe(2);
    expect(res.buffer).toBe("second line\nthird line");
  });

  it("pty_session sends ctrl_c interrupt", async () => {
    let sentInput = "";
    const ctx = {
      ...makeContext("active process running"),
      injectIntoActivePty: (text: string) => {
        sentInput = text;
        return true;
      },
    };
    const tools = buildPtyDriverTools(ctx);
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ action: "ctrl_c" }, {} as any)) as any;
    expect(res.action).toBe("ctrl_c");
    expect(res.sent).toBe(true);
    expect(sentInput).toBe("\x03");
  });

  it("pty_session injects write input", async () => {
    let sentInput = "";
    const ctx = {
      ...makeContext("prompt: "),
      injectIntoActivePty: (text: string) => {
        sentInput = text;
        return true;
      },
    };
    const tools = buildPtyDriverTools(ctx);
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ action: "write", input: "yes\r" }, {} as any)) as any;
    expect(res.action).toBe("write");
    expect(res.sent).toBe(true);
    expect(sentInput).toBe("yes\r");
  });

  it("pty_session refuses destructive commands on run action", async () => {
    const tools = buildPtyDriverTools(makeContext());
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ action: "run", command: "rm -rf /" }, {} as any)) as any;
    expect(res.error).toMatch(/Refused/i);
  });

  it("pty_session runs command and returns output", async () => {
    let injected = "";
    const ctx = {
      ...makeContext("$ initial prompt\n"),
      injectIntoActivePty: (text: string) => {
        injected = text;
        return true;
      },
    };
    const tools = buildPtyDriverTools(ctx);
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ action: "run", command: "echo hello", timeout_secs: 1 }, {} as any)) as any;
    expect(res.action).toBe("run");
    expect(res.command).toBe("echo hello");
    expect(injected).toBe("echo hello\r");
  });

  it("pty_session handles string timeout_secs and cmd alias", async () => {
    let injected = "";
    let calls = 0;
    const ctx = {
      ...makeContext("$ initial prompt\n"),
      getTerminalContext: () => {
        calls++;
        return calls > 2 ? "$ initial prompt\ncargo test output\n$ " : "$ initial prompt\n";
      },
      injectIntoActivePty: (text: string) => {
        injected = text;
        return true;
      },
    };
    const tools = buildPtyDriverTools(ctx);
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: test harness
    const res = (await exec({ cmd: "cargo test", timeout_secs: "5", max_lines: "80" }, {} as any)) as any;
    expect(res.action).toBe("run");
    expect(res.command).toBe("cargo test");
    expect(injected).toBe("cargo test\r");
    expect(res.output).toContain("cargo test output");
  });
});

describe("ptyDriver privacy mode", () => {
  it("pty_read_screen refuses without reading the buffer", async () => {
    const getTerminalContext = vi.fn(() => "secret token abc123");
    const tools = buildPtyDriverTools({
      ...makeContext("secret token abc123", { private: true }),
      getTerminalContext,
    });
    const exec = tools.pty_read_screen.execute;
    if (!exec) throw new Error("pty_read_screen execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ max_lines: 50 }, {} as any)) as any;
    expect(res.error).toMatch(/privacy mode/i);
    expect(res.buffer ?? "").not.toContain("secret");
    expect(getTerminalContext).not.toHaveBeenCalled();
  });

  it("pty_wait_for_pattern refuses in privacy mode", async () => {
    const tools = buildPtyDriverTools(
      makeContext("secret token abc123", { private: true }),
    );
    const exec = tools.pty_wait_for_pattern.execute;
    if (!exec) throw new Error("pty_wait_for_pattern execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ pattern: "secret" }, {} as any)) as any;
    expect(res.found).toBe(false);
    expect(res.error).toMatch(/privacy mode/i);
  });

  it("pty_session read refuses in privacy mode", async () => {
    const tools = buildPtyDriverTools(
      makeContext("secret token abc123", { private: true }),
    );
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ action: "read" }, {} as any)) as any;
    expect(res.error).toMatch(/privacy mode/i);
  });

  it("pty_session ctrl_c still signals but withholds the buffer", async () => {
    let injected = "";
    const tools = buildPtyDriverTools({
      ...makeContext("secret token abc123", { private: true }),
      injectIntoActivePty: (text: string) => {
        injected = text;
        return true;
      },
    });
    const exec = tools.pty_session.execute;
    if (!exec) throw new Error("pty_session execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: tool ctx and result are harness-typed, empty exec ctx is enough
    const res = (await exec({ action: "ctrl_c" }, {} as any)) as any;
    expect(injected).toBe("");
    expect(res.sent).toBe(true);
    expect(res.buffer ?? "").not.toContain("secret");
  });
});

