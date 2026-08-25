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
    openPreview: () => false,
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

describe("browser tools", () => {
  it("refuses SSRF targets in browser_open before touching the context", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    for (const url of [
      "http://169.254.169.254",
      "http://127.0.0.1",
      "http://2130706433",
      "http://[fe80::1]/",
      "file:///etc/passwd",
    ]) {
      const r = (await tools.browser_open.execute(
        { instance: "x", url },
        OPTS,
      )) as { error?: string };
      expect(r.error, url).toBeTruthy();
    }
    expect(ctx.browserOpen).not.toHaveBeenCalled();
  });

  it("opens an external site and passes through the context", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = await tools.browser_open.execute(
      { instance: "docs", url: "https://example.com" },
      OPTS,
    );
    expect(r).toEqual({ url: "https://example.com" });
    expect(ctx.browserOpen).toHaveBeenCalledWith("docs", "https://example.com");
  });

  it("refuses a metadata URL in browser_navigate", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await tools.browser_navigate.execute(
      { instance: "x", url: "http://169.254.169.254" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toBeTruthy();
    expect(ctx.browserNavigate).not.toHaveBeenCalled();
  });

  it("injects click JS with a JSON-quoted selector", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = await tools.browser_click.execute(
      { instance: "docs", selector: "button.submit" },
      OPTS,
    );
    expect(r).toEqual({ ok: true });
    const js = (ctx.browserEval as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(js).toContain("document.querySelector(\"button.submit\")");
    expect(js).toContain("el.click()");
  });

  it("injects type JS that fires input/change events", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = await tools.browser_type.execute(
      { instance: "docs", selector: "input[name='q']", text: "hello" },
      OPTS,
    );
    expect(r).toEqual({ ok: true });
    const js = (ctx.browserEval as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(js).toContain("input[name='q']");
    expect(js).toContain("dispatchEvent(new Event('input'");
  });

  it("lists open instances", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = await tools.browser_list.execute({}, OPTS);
    expect(r).toEqual({ instances: ["docs"] });
  });
});
