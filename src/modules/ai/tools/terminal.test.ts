import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";
import { buildTerminalTools } from "./terminal";

type Overrides = Partial<{
  isActiveTerminalPrivate: () => boolean;
  getTerminalContext: () => string | null;
  openPreview: (url: string) => boolean;
  openCanvas: (html: string, title?: string) => boolean;
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
    openCanvas: o.openCanvas ?? (() => true),
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

async function suggest(
  ctx: ToolContext,
  command: string,
  explanation?: string,
) {
  const execute = buildTerminalTools(ctx).suggest_command.execute;
  if (!execute) throw new Error("suggest_command has no execute");
  return (await execute({ command, explanation } as never, OPTS)) as {
    command?: string;
    explanation?: string;
    error?: string;
  };
}

async function renderView(ctx: ToolContext, html: string, title?: string) {
  const execute = buildTerminalTools(ctx).render_view.execute;
  if (!execute) throw new Error("render_view has no execute");
  return (await execute({ html, title } as never, OPTS)) as {
    ok?: boolean;
    title?: string;
    error?: string;
    mermaid?: string;
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
describe("open_preview accepts loopback and safe external hosts", () => {
  it("accepts the local dev server in its usual spellings", async () => {
    for (const url of [
      "http://localhost:5173",
      "http://127.0.0.1:3000/path",
      "http://app.localhost:1234",
      "https://localhost:5173",
    ]) {
      const r = await preview(makeContext(), url);
      expect(r.ok, url).toBe(true);
    }
  });

  it("accepts a safe external host (it renders in the embedded browser)", async () => {
    for (const url of [
      "https://example.com",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
    ]) {
      const r = await preview(makeContext(), url);
      expect(r.ok, url).toBe(true);
    }
  });

  it("still refuses SSRF targets (metadata, link-local, loopback-IP tricks)", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal",
      "http://[fe80::1]/",
      // 0.0.0.0 is a wildcard BIND address, never a destination a client can
      // address — dev-server logs print it, but the preview target is
      // localhost/127.0.0.1. browserGuard refuses it on purpose.
      "http://0.0.0.0:8080",
    ]) {
      const r = await preview(makeContext(), url);
      expect(r.ok, url).toBeUndefined();
      expect(r.error, url).toBeTruthy();
    }
  });

  it("tells the model what to use instead of a wildcard bind address", async () => {
    // Dev-server banners print http://0.0.0.0:5173; a nameless refusal made
    // the agent retry the same URL. The error now names the fix + the port.
    const r = await preview(makeContext(), "http://0.0.0.0:5173");
    expect(r.error).toMatch(/localhost:5173/);
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

describe("suggest_command", () => {
  it("accepts a clean command and returns it", async () => {
    const r = await suggest(makeContext(), "git status");
    expect(r.command).toBe("git status");
    expect(r.error).toBeUndefined();
  });

  it("passes the explanation through", async () => {
    const r = await suggest(makeContext(), "pnpm install", "install deps");
    expect(r.command).toBe("pnpm install");
    expect(r.explanation).toBe("install deps");
  });

  it("refuses a command with control characters", async () => {
    const r = await suggest(makeContext(), "echo hello\nrm -rf /");
    expect(r.error).toMatch(/control characters/i);
  });

  it("refuses a command the shell guard blocks", async () => {
    const r = await suggest(makeContext(), "rm -rf /");
    expect(r.error).toBeTruthy();
  });
});

describe("render_view", () => {
  it("opens a canvas tab and returns ok", async () => {
    const r = await renderView(makeContext(), "<h1>Hello</h1>", "Plan");
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Plan");
  });

  it("defaults the title to Canvas", async () => {
    const r = await renderView(makeContext(), "<div/>");
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Canvas");
  });

  it("reports when the canvas surface is unavailable", async () => {
    const r = await renderView(
      makeContext({ openCanvas: () => false }),
      "<div/>",
    );
    expect(r.error).toMatch(/canvas surface unavailable/i);
  });

  // The canvas strips <script> and runs no scripts, so a Mermaid HTML view
  // would render blank. The tool must NOT open the canvas — it returns the
  // fenced block so the model shows the diagram in chat instead.
  it("refuses a Mermaid HTML view and returns the fenced block", async () => {
    const html = `<html><head><script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script></head>
<body><pre class="mermaid">flowchart LR
A --> B</pre></body></html>`;
    const openCanvas = vi.fn(() => true);
    const r = await renderView(makeContext({ openCanvas }), html, "Graph");
    expect(openCanvas).not.toHaveBeenCalled();
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/blank/i);
    expect(r.mermaid).toContain("flowchart LR");
    expect(r.mermaid).toContain("A --> B");
  });

  it("detects a fenced mermaid block inside the HTML too", async () => {
    const html = `<div>plan</div>\n\`\`\`mermaid\nsequenceDiagram\nA->>B: hi\n\`\`\`\n`;
    const r = await renderView(
      makeContext({ openCanvas: vi.fn(() => true) }),
      html,
    );
    expect(r.ok).toBeUndefined();
    expect(r.mermaid).toContain("sequenceDiagram");
  });
});
