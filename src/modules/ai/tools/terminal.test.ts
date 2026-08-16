import { describe, expect, it, vi } from "vitest";
import { buildTerminalTools } from "./terminal";
import type { ToolContext } from "./context";

type Overrides = Partial<{
  isActiveTerminalPrivate: () => boolean;
  getTerminalContext: () => string | null;
  openPreview: (url: string) => boolean;
}>;

function makeContext(o: Overrides = {}): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: o.getTerminalContext ?? (() => "line one\nline two"),
    isActiveTerminalPrivate: o.isActiveTerminalPrivate ?? (() => false),
    injectIntoActivePty: () => false,
    openPreview: o.openPreview ?? (() => true),
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
  } as unknown as ToolContext;
}

const OPTS = { toolCallId: "t", messages: [] } as never;

async function readTerminal(ctx: ToolContext, input: unknown = {}) {
  const execute = buildTerminalTools(ctx).get_terminal_output.execute;
  if (!execute) throw new Error("get_terminal_output has no execute");
  return (await execute(input as never, OPTS)) as {
    output?: string;
    error?: string;
    note?: string;
  };
}

async function preview(ctx: ToolContext, url: string) {
  const execute = buildTerminalTools(ctx).open_preview.execute;
  if (!execute) throw new Error("open_preview has no execute");
  return (await execute({ url } as never, OPTS)) as {
    ok?: boolean;
    error?: string;
  };
}

// Privacy mode is a privacy control whose entire enforcement is one branch in
// this tool. Nothing else would notice if a later change read the buffer
// without checking, so the guard is pinned here rather than trusted.
describe("Privacy mode withholds the terminal", () => {
  it("refuses to return the buffer of a private terminal", async () => {
    const getTerminalContext = vi.fn(() => "secret token abc123");
    const r = await readTerminal(
      makeContext({ isActiveTerminalPrivate: () => true, getTerminalContext }),
    );
    expect(r.error).toMatch(/privacy mode/i);
    expect(r.output).toBeUndefined();
  });

  it("does not even read the buffer when the terminal is private", async () => {
    const getTerminalContext = vi.fn(() => "secret token abc123");
    await readTerminal(
      makeContext({ isActiveTerminalPrivate: () => true, getTerminalContext }),
    );
    expect(getTerminalContext).not.toHaveBeenCalled();
  });

  it("never leaks the buffer contents into the refusal", async () => {
    const r = await readTerminal(
      makeContext({
        isActiveTerminalPrivate: () => true,
        getTerminalContext: () => "secret token abc123",
      }),
    );
    expect(JSON.stringify(r)).not.toContain("abc123");
  });

  // The agent has to know a terminal exists but is off limits, or it reads the
  // refusal as "there is no terminal" and asks the user where they are.
  it("says how to make it readable rather than just refusing", async () => {
    const r = await readTerminal(
      makeContext({ isActiveTerminalPrivate: () => true }),
    );
    expect(r.error).toMatch(/regular tab/i);
  });

  it("returns the buffer for an ordinary terminal", async () => {
    const r = await readTerminal(makeContext());
    expect(r.output).toContain("line one");
  });
});

// The preview surface is an in-app iframe, so the host allow-list is what
// stops an agent opening arbitrary pages inside the user's app.
describe("open_preview accepts only loopback", () => {
  it("accepts the local dev server in its usual spellings", async () => {
    for (const url of [
      "http://localhost:5173",
      "http://127.0.0.1:3000/path",
      "http://0.0.0.0:8080",
      "http://app.localhost:1234",
      "https://localhost:5173",
    ]) {
      const r = await preview(makeContext(), url);
      expect(r.ok, url).toBe(true);
    }
  });

  it("refuses an external host and says what to do instead", async () => {
    const r = await preview(makeContext(), "https://example.com");
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/localhost/i);
    expect(r.error).toMatch(/address bar/i);
  });

  // A hostname that merely starts with a loopback name is not loopback.
  it("is not fooled by a host that only looks local", async () => {
    for (const url of [
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
    ]) {
      const r = await preview(makeContext(), url);
      expect(r.ok, url).toBeUndefined();
      expect(r.error, url).toBeTruthy();
    }
  });

  it("refuses a scheme that is not http or https", async () => {
    const r = await preview(makeContext(), "file:///etc/passwd");
    expect(r.error).toMatch(/http/i);
  });

  it("reports when the preview surface is unavailable", async () => {
    const r = await preview(
      makeContext({ openPreview: () => false }),
      "http://localhost:5173",
    );
    expect(r.error).toMatch(/unavailable/i);
  });
});
