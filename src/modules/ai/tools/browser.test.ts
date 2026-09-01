import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrowserTools } from "./browser";
import type { ToolContext } from "./context";

// The read/act browser tools drive the native embedded webview through the
// `browser_embed_*` Rust commands, so we mock the native bridge and assert on it.
vi.mock("../lib/native", () => ({
  native: {
    browserEmbedNavigate: vi.fn(async () => undefined),
    browserEmbedRead: vi.fn(async () => "body text"),
    browserEmbedEval: vi.fn(async () => undefined),
    browserEmbedClose: vi.fn(async () => undefined),
  },
}));

import { native } from "../lib/native";

function makeCtx(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: vi.fn(() => true),
    openCanvas: () => false,
    browserOpen: vi.fn(async () => ({ url: "https://example.com" })),
    browserNavigate: vi.fn(async () => ({ url: "https://example.com" })),
    browserBack: vi.fn(async () => ({ ok: true as const })),
    browserForward: vi.fn(async () => ({ ok: true as const })),
    browserReload: vi.fn(async () => ({ ok: true as const })),
    browserExtract: vi.fn(async () => ({ text: "body text" })),
    browserEval: vi.fn(async () => ({ ok: true as const })),
    browserScreenshot: vi.fn(async () => ({
      screenshot: "data:image/png;base64,AA",
    })),
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

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it("opens an external site as an embedded browser tab keyed by instance", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_open)(
      { instance: "docs", url: "https://example.com" },
      OPTS,
    )) as { url?: string; ok?: boolean; instance?: string };
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://example.com");
    expect(r.instance).toBe("docs");
    // The instance name threads to the preview so read/act tools can find the webview.
    expect(ctx.openPreview).toHaveBeenCalledWith("https://example.com", "docs");
  });

  it("refuses a metadata URL in browser_navigate", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_navigate)(
      { instance: "x", url: "http://169.254.169.254" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toBeTruthy();
    expect(native.browserEmbedNavigate).not.toHaveBeenCalled();
  });

  it("navigates the embed webview to a safe URL", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_navigate)(
      { instance: "docs", url: "https://example.com/page" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    expect(native.browserEmbedNavigate).toHaveBeenCalledWith(
      "docs",
      "https://example.com/page",
    );
  });

  it("reads the rendered page text from the embed webview", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_extract)(
      { instance: "docs" },
      OPTS,
    )) as { text?: string };
    expect(r.text).toBe("body text");
    expect(native.browserEmbedRead).toHaveBeenCalledWith("docs");
  });

  it("injects click JS with a JSON-quoted selector via the embed eval", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_click)(
      { instance: "docs", selector: "button.submit" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    const calls = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls;
    const js = calls[0][1] as string;
    expect(js).toContain('document.querySelector("button.submit")');
    expect(js).toContain("No element matched selector");
    expect(js).toContain("el.click()");
  });

  it("injects type JS that fires input/change events via the embed eval", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_type)(
      { instance: "docs", selector: "input[name='q']", text: "hello" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    const calls = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls;
    const js = calls[0][1] as string;
    expect(js).toContain("input[name='q']");
    expect(js).toContain("No element matched selector");
    expect(js).toContain("input-like element");
    expect(js).toContain("dispatchEvent(new Event('input'");
  });

  it("closes the embed webview by instance", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_close)(
      { instance: "docs" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    expect(native.browserEmbedClose).toHaveBeenCalledWith("docs");
  });
});
