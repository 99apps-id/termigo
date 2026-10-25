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
    browserEmbedScreenshot: vi.fn(
      async () => "data:image/png;base64,mockBase64",
    ),
    readFileBase64: vi.fn(async () => ({
      media_type: "image/png",
      data: "QUJD",
      size: 3,
    })),
    writeFileBase64: vi.fn(async () => 3),
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
  it("refuses true SSRF targets in browser_open but allows loopback dev servers", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const run = execOf(tools.browser_open);
    // These are still blocked.
    for (const url of [
      "http://169.254.169.254",
      "http://[fe80::1]/",
      "file:///etc/passwd",
    ]) {
      const r = (await run({ instance: "x", url }, OPTS)) as { error?: string };
      expect(r.error, url).toBeTruthy();
      expect(ctx.openPreview).not.toHaveBeenCalled();
    }
    // Loopback dev servers are allowed because `browser_open` now uses the
    // embedded preview pane (same surface as `open_preview`).
    ctx.openPreview.mockClear();
    for (const url of [
      "http://127.0.0.1",
      "http://2130706433",
      "http://localhost:5173",
    ]) {
      const r = (await run({ instance: "docs", url }, OPTS)) as {
        url?: string;
        ok?: boolean;
      };
      expect(r.error, url).toBeUndefined();
      expect(r.ok).toBe(true);
    }
    expect(ctx.openPreview).toHaveBeenCalledTimes(3);
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

  it("drives a React controlled input through the prototype value setter", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    await execOf(tools.browser_type)(
      { instance: "docs", selector: "input[name='q']", text: "hello" },
      OPTS,
    );
    const js = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    // A direct `el.value = ...` is invisible to React's value tracker; the
    // prototype setter is what makes onChange fire for a controlled input.
    expect(js).toContain("getOwnPropertyDescriptor");
    expect(js).toContain("desc.set.call(el");
    expect(js).toContain("dispatchEvent(new Event('change'");
  });

  it("supports ref IDs for browser_click and browser_type", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    await execOf(tools.browser_click)({ instance: "docs", ref: "@e1" }, OPTS);
    let calls = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[0][1]).toContain('[data-termigo-ref=\\"@e1\\"]');

    await execOf(tools.browser_type)(
      { instance: "docs", ref: "e2", text: "termigo" },
      OPTS,
    );
    calls = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][1]).toContain('[data-termigo-ref=\\"@e2\\"]');
  });

  it("presses Enter on the focused element when no target is given", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_press)(
      { instance: "docs", key: "Enter" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    const js = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(js).toContain("document.activeElement||document.body");
    expect(js).toContain("KeyboardEvent('keydown'");
    expect(js).toContain('"Enter"');
  });

  it("focuses a snapshot ref before pressing a key", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    await execOf(tools.browser_press)(
      { instance: "docs", key: "Tab", ref: "@e3" },
      OPTS,
    );
    const js = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(js).toContain('[data-termigo-ref=\\"@e3\\"]');
    expect(js).toContain('"Tab"');
  });

  it("rejects a bad ref in browser_press without touching the webview", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_press)(
      { instance: "docs", key: "Enter", ref: "nope" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toContain("Invalid ref format");
    expect(native.browserEmbedEval).not.toHaveBeenCalled();
  });

  it("takes accessibility snapshot via browser_snapshot", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_snapshot)(
      { instance: "docs" },
      OPTS,
    )) as { snapshot?: string };
    expect(r.snapshot).toBe("body text");
    expect(native.browserEmbedEval).toHaveBeenCalled();
    const calls = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls;
    const js = calls[calls.length - 1][1] as string;
    expect(js).toContain("document.querySelectorAll('iframe')");
    expect(js).toContain("captcha-iframe");
    expect(native.browserEmbedRead).toHaveBeenCalledWith("docs");
  });

  it("refuses SSRF URLs in browser_connect new_tab", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_connect)(
      { action: "new_tab", url: "http://169.254.169.254/latest/meta-data" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toBeTruthy();
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

  it("breaks repetition loop when browser_extract repeatedly returns no readable text", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    (native.browserEmbedRead as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "(no readable text returned from the page. It may still be loading.)",
    );
    const first = (await execOf(tools.browser_extract)(
      { instance: "loop-test" },
      OPTS,
    )) as { text?: string; error?: string };
    expect(first.text).toContain("no readable text");
    expect(first.error).toBeUndefined();

    (native.browserEmbedRead as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "(no readable text returned from the page. It may still be loading.)",
    );
    const second = (await execOf(tools.browser_extract)(
      { instance: "loop-test" },
      OPTS,
    )) as { text?: string; error?: string };
    expect(second.error).toContain("No readable text could be extracted");
  });

  it("reports isOffline flag when browser_navigate encounters a network or DNS failure", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    (
      native.browserEmbedNavigate as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND example.invalid"));
    const r = (await execOf(tools.browser_navigate)(
      { instance: "docs", url: "https://example.invalid" },
      OPTS,
    )) as { error?: string; isOffline?: boolean; hint?: string };
    expect(r.error).toContain("ENOTFOUND");
    expect(r.isOffline).toBe(true);
    expect(r.hint).toContain("network is offline");
  });

  it("reads captured console output via browser_console", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_console)(
      { instance: "docs" },
      OPTS,
    )) as { console?: string };
    expect(r.console).toBe("warn: hi");
    expect(ctx.browserConsole).toHaveBeenCalledWith("docs");
  });

  it("captures screenshot and guards against repetitive loops without intervening actions", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);

    // 1st screenshot succeeds
    const first = (await execOf(tools.browser_screenshot)(
      { instance: "app-loop" },
      OPTS,
    )) as { kind?: string; data?: string; hint?: string; error?: string };
    expect(first.kind).toBe("screenshot");
    expect(first.data).toBe("data:image/png;base64,mockBase64");
    expect(first.hint).toBeUndefined();

    // 2nd consecutive screenshot succeeds with hint warning
    const second = (await execOf(tools.browser_screenshot)(
      { instance: "app-loop" },
      OPTS,
    )) as { kind?: string; data?: string; hint?: string; error?: string };
    expect(second.kind).toBe("screenshot");
    expect(second.hint).toContain("dark background");

    // 3rd consecutive screenshot returns error to break the loop
    const third = (await execOf(tools.browser_screenshot)(
      { instance: "app-loop" },
      OPTS,
    )) as { error?: string };
    expect(third.error).toContain(
      "Consecutive browser_screenshot limit reached",
    );

    // Intervening action resets the counter
    await execOf(tools.browser_navigate)(
      { instance: "app-loop", url: "https://example.com" },
      OPTS,
    );

    // Screenshot succeeds again after intervening action
    const fourth = (await execOf(tools.browser_screenshot)(
      { instance: "app-loop" },
      OPTS,
    )) as { kind?: string; data?: string; error?: string };
    expect(fourth.kind).toBe("screenshot");
    expect(fourth.error).toBeUndefined();
  });

  it("selects a dropdown option by value then label", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_select)(
      { instance: "docs", selector: "select#country", option: "Indonesia" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    const js = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(js).toContain("HTMLSelectElement");
    expect(js).toContain("selectedIndex=idx");
    expect(js).toContain("dispatchEvent(new Event('change'");
  });

  it("rejects browser_select on a non-select element via the page", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    (native.browserEmbedEval as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("not a select"),
    );
    const r = (await execOf(tools.browser_select)(
      { instance: "docs", selector: "div", option: "x" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toContain("not a select");
  });

  it("scrolls to an element, an offset, or top/bottom", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    await execOf(tools.browser_scroll)({ instance: "docs", ref: "@e5" }, OPTS);
    let calls = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[0][1]).toContain("scrollIntoView");

    await execOf(tools.browser_scroll)(
      { instance: "docs", to: "bottom" },
      OPTS,
    );
    calls = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][1]).toContain("document.body.scrollHeight");

    const bad = (await execOf(tools.browser_scroll)(
      { instance: "docs" },
      OPTS,
    )) as { error?: string };
    expect(bad.error).toContain("give an element");
  });

  it("hovers an element with pointer and mouse events", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_hover)(
      { instance: "docs", selector: ".menu" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    const js = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(js).toContain("pointerover");
    expect(js).toContain("mouseenter");
  });

  it("browser_wait_for returns once the text appears", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    (native.browserEmbedRead as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("loading…")
      .mockResolvedValueOnce("Welcome back, you are logged in");
    const r = (await execOf(tools.browser_wait_for)(
      { instance: "docs", kind: "text", value: "logged in" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
  });

  it("browser_wait_for times out with guidance instead of hanging", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    (native.browserEmbedRead as ReturnType<typeof vi.fn>).mockResolvedValue(
      "loading…",
    );
    const r = (await execOf(tools.browser_wait_for)(
      { instance: "docs", kind: "text", value: "never", timeout_ms: 600 },
      OPTS,
    )) as { error?: string };
    expect(r.error).toContain("timed out");
  });

  it("lists cookies through the value channel", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    (native.browserEmbedRead as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({ cookies: "session=abc" }),
    );
    const r = (await execOf(tools.browser_storage)(
      { instance: "docs", target: "cookies", action: "list" },
      OPTS,
    )) as { cookies?: string };
    expect(r.cookies).toBe("session=abc");
  });

  it("lists network requests through the value channel", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    (native.browserEmbedRead as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({
        requests: [{ url: "https://api.example.com/login", type: "fetch" }],
        count: 1,
      }),
    );
    const r = (await execOf(tools.browser_network)(
      { instance: "docs" },
      OPTS,
    )) as { requests?: unknown[]; count?: number };
    expect(r.count).toBe(1);
    expect(r.requests).toHaveLength(1);
  });

  it("uploads a workspace file into a file input with approval", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    expect(tools.browser_upload).toMatchObject({ needsApproval: true });
    const r = (await execOf(tools.browser_upload)(
      { instance: "docs", selector: "input[type=file]", path: "a.png" },
      OPTS,
    )) as { ok?: boolean };
    expect(r.ok).toBe(true);
    expect(native.readFileBase64).toHaveBeenCalledWith("/workspace/a.png");
    const js = (native.browserEmbedEval as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(js).toContain("DataTransfer");
    expect(js).toContain("a.png");
  });

  it("refuses browser_upload over SSH and oversized files", async () => {
    const remote = {
      ...makeCtx(),
      getRemoteSession: () => ({ sessionId: 1, cwd: null }),
    };
    const tools = buildBrowserTools(remote);
    const r = (await execOf(tools.browser_upload)(
      { instance: "docs", selector: "input", path: "a.png" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toContain("not available over SSH");

    const big = makeCtx();
    (native.readFileBase64 as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      media_type: "application/octet-stream",
      data: "AA",
      size: 99_000_000,
    });
    const r2 = (await execOf(buildBrowserTools(big).browser_upload)(
      { instance: "docs", selector: "input", path: "big.bin" },
      OPTS,
    )) as { error?: string };
    expect(r2.error).toContain("over the");
  });

  it("downloads a file through page context into the workspace", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    expect(tools.browser_download).toMatchObject({ needsApproval: true });
    const dataUrl = "data:text/plain;base64,aGVsbG8=";
    (native.browserEmbedRead as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({
        chunk: dataUrl,
        last: true,
        total: dataUrl.length,
        error: null,
      }),
    );
    const r = (await execOf(tools.browser_download)(
      { instance: "docs", url: "https://example.com/f.txt", path: "f.txt" },
      OPTS,
    )) as { ok?: boolean; path?: string };
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/workspace/f.txt");
    expect(native.writeFileBase64).toHaveBeenCalledWith(
      "/workspace/f.txt",
      "aGVsbG8=",
    );
  });

  it("refuses SSRF targets in browser_download", async () => {
    const ctx = makeCtx();
    const tools = buildBrowserTools(ctx);
    const r = (await execOf(tools.browser_download)(
      { instance: "docs", url: "http://169.254.169.254/x", path: "x" },
      OPTS,
    )) as { error?: string };
    expect(r.error).toBeTruthy();
    expect(native.writeFileBase64).not.toHaveBeenCalled();
  });
});
