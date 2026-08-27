import { describe, expect, it, vi } from "vitest";
import { buildBrowserTools } from "./browser";
import type { ToolContext } from "./context";

function makeCtx(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: vi.fn(() => true),
    browserOpen: vi.fn(async () => ({ url: "https://example.com" })),
    browserNavigate: vi.fn(async () => ({ url: "https://example.com" })),
    browserBack: vi.fn(async () => ({ ok: true as const })),
    browserForward: vi.fn(async () => ({ ok: true as const })),
    browserReload: vi.fn(async () => ({ ok: true as const })),
    browserExtract: vi.fn(async () => ({ text: "body text" })),
    browserEval: vi.fn(async () => ({ ok: true as const })),
    browserScreenshot: vi.fn(async () => ({ screenshot: "data:image/png;base64,AA" })),
    browserConsole: vi.fn(async () => ({ console: "warn: hi" })),
    browserUrl: vi.fn(async () => ({ url: "https://example.com" })),
    browserClose: vi.fn(async () => ({ ok: true as const })),
    browserList: vi.fn(async () => ["docs"]),
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
  };
}

const OPTS = { toolCallId: "t", messages: [] } as never;

type Exec = (
  args: Record<string, unknown>,
  options: { toolCallId: string; messages: never[] },
) => Promise<unknown>;

function execOf(tool: { execute?: unknown }): Exec {
  const fn = tool.execute;
  if (typeof fn !== "function") throw new Error("tool has no execute");
  return fn as Exec;
}

describe("browser tools", () => {
  it("refuses SSRF targets in browser_open before touching the context", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const run = execOf(tools.browser_open);
    for (const url of [
      "http://169.254.169.254",
      "http://127.0.0.1",
      "http://2130706433",
      "http://[fe80::1]/",
      "file:///etc/passwd",
    ]) {
      const r = (await run({ instance: "x", url }, OPTS)) as { error?: string };
      expect(r.error, url).toBeTruthy();
    }
    expect(ctx.openPreview).not.toHaveBeenCalled();
  });

  it("opens an external site as an embedded browser tab", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_open)(
      { instance: "docs", url: "https://example.com" },
      OPTS,
    )) as { url?: string; ok?: boolean };
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://example.com");
    expect(ctx.openPreview).toHaveBeenCalledWith("https://example.com");
  });

  it("refuses a metadata URL in browser_navigate", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_navigate)(
      { instance: "x", url: "http://169.254.169.254" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toBeTruthy();
    expect(ctx.browserNavigate).not.toHaveBeenCalled();
  });

  it("injects click JS with a JSON-quoted selector", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_click)(
      { instance: "docs", selector: "button.submit" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    const calls = (ctx.browserEval as ReturnType<typeof vi.fn>).mock.calls;
    const js = calls[0][1] as string;
    expect(js).toContain("document.querySelector(\"button.submit\")");
    expect(js).toContain("el.click()");
  });

  it("injects type JS that fires input/change events", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_type)(
      { instance: "docs", selector: "input[name='q']", text: "hello" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    const calls = (ctx.browserEval as ReturnType<typeof vi.fn>).mock.calls;
    const js = calls[0][1] as string;
    expect(js).toContain("input[name='q']");
    expect(js).toContain("dispatchEvent(new Event('input'");
  });

  it("lists open instances", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_list)(
      {},
      OPTS,
    )) as { instances?: string[] };
    expect(r.instances).toEqual(["docs"]);
  });
});
