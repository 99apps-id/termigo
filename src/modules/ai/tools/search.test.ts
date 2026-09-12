import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const nativeMock = vi.hoisted(() => ({
  canonicalize: vi.fn(async (path: string) => path),
  glob: vi.fn(),
  grep: vi.fn(),
}));

vi.mock("../lib/native", () => ({
  native: nativeMock,
}));

import { SEARCH_PATTERN_HINT } from "../lib/regexEngine";
import { buildSearchTools } from "./search";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    // No SSH session in these fixtures: tools resolve locally.
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
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

type GrepToolResult = {
  hits: { path: string; rel: string; line: number; text: string }[];
};

type GlobToolResult = {
  hits: { path: string; rel: string }[];
};

describe("AI search tools path safety", () => {
  beforeEach(() => {
    nativeMock.canonicalize.mockClear();
    nativeMock.glob.mockReset();
    nativeMock.grep.mockReset();
  });

  it("filters grep hits that read_file would refuse", async () => {
    nativeMock.grep.mockResolvedValue({
      hits: [
        {
          path: "/workspace/src/app.ts",
          rel: "workspace/src/app.ts",
          line: 7,
          text: "const tokenName = 'safe fixture';",
        },
        {
          path: "/workspace/secrets.json",
          rel: "workspace/secrets.json",
          line: 1,
          text: '{"token":"secret"}',
        },
        {
          path: "/workspace/server.pem",
          rel: "workspace/server.pem",
          line: 1,
          text: "BEGIN PRIVATE KEY",
        },
        {
          path: "/etc/passwd",
          rel: "etc/passwd",
          line: 1,
          text: "root:x:0:0:root:/root:/bin/sh",
        },
      ],
      truncated: false,
      files_scanned: 4,
    });

    const tools = buildSearchTools(makeContext());
    const execute = tools.grep.execute;
    if (!execute) throw new Error("grep tool execute missing");
    const result = (await execute(
      { pattern: "token|root|PRIVATE KEY", root: "/" },
      toolOptions,
    )) as GrepToolResult;

    expect(result.hits.map((h) => h.path)).toEqual(["/workspace/src/app.ts"]);
    expect(result.hits.map((h) => h.text)).toEqual([
      "const tokenName = 'safe fixture';",
    ]);
  });

  it("filters glob hits that enumerate sensitive paths", async () => {
    nativeMock.glob.mockResolvedValue({
      hits: [
        { path: "/home/me/project/src/index.ts", rel: "src/index.ts" },
        { path: "/home/me/project/id_rsa", rel: "id_rsa" },
        { path: "/home/me/project/.ssh/config", rel: ".ssh/config" },
        { path: "service-account-prod.json", rel: "service-account-prod.json" },
        { path: "/etc/passwd", rel: "../../etc/passwd" },
      ],
      truncated: false,
    });

    const tools = buildSearchTools(makeContext());
    const execute = tools.glob.execute;
    if (!execute) throw new Error("glob tool execute missing");
    const result = (await execute(
      { pattern: "**/*", root: "/home/me/project" },
      toolOptions,
    )) as GlobToolResult;

    expect(result.hits).toEqual([
      { path: "/home/me/project/src/index.ts", rel: "src/index.ts" },
    ]);
  });

  it("defaults grep root to the active cwd, not the workspace root", async () => {
    nativeMock.grep.mockResolvedValue({
      hits: [
        {
          path: "/repo/app/routes.ts",
          rel: "app/routes.ts",
          line: 3,
          text: "x",
        },
      ],
      truncated: false,
      files_scanned: 1,
    });
    nativeMock.canonicalize.mockResolvedValue("/repo");

    // The shell cwd is the repo being analysed; the explorer root is elsewhere.
    const ctx = makeContext();
    ctx.getCwd = () => "/repo";
    ctx.getWorkspaceRoot = () => "/elsewhere";

    const tools = buildSearchTools(ctx);
    const execute = tools.grep.execute;
    if (!execute) throw new Error("grep tool execute missing");
    const result = (await execute({ pattern: "x" }, toolOptions)) as {
      root: string;
      hits: unknown[];
    };

    expect(result.root).toBe("/repo");
    expect(nativeMock.grep).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/repo" }),
    );
  });
});

// A model with exactly one pattern writes `"glob": "src/**/*.ts"`, not a
// one-element list. The array-only schema rejected the whole call, so the tool
// never ran and the run died on a validation error instead of a search.
//
// The bare-string form is normalised in `execute`, not by a Zod `.transform()`:
// a transform cannot be expressed in JSON Schema, so it made this the one tool
// whose schema could not be measured for the request-size report.
describe("grep glob accepts one pattern or several", () => {
  const schemaOf = (tools: Record<string, unknown>) =>
    (tools.grep as { inputSchema: { parse: (v: unknown) => unknown } })
      .inputSchema;

  it("accepts a bare string", () => {
    const tools = buildSearchTools(makeContext());
    expect(() =>
      schemaOf(tools).parse({
        pattern: "fs_read_file",
        glob: "src-tauri/src/lib.rs",
      }),
    ).not.toThrow();
  });

  it("still takes a list", () => {
    const tools = buildSearchTools(makeContext());
    const parsed = schemaOf(tools).parse({
      pattern: "x",
      glob: ["**/*.ts", "src/**/*.tsx"],
    }) as { glob?: string[] };
    expect(parsed.glob).toEqual(["**/*.ts", "src/**/*.tsx"]);
  });

  it("leaves it absent when omitted", () => {
    const tools = buildSearchTools(makeContext());
    const parsed = schemaOf(tools).parse({ pattern: "x" }) as {
      glob?: string[];
    };
    expect(parsed.glob).toBeUndefined();
  });

  it("sends the same search for a bare string as for a one-element list", async () => {
    // The behavior the transform used to provide, now checked where it happens.
    const run = async (glob: string | string[]) => {
      nativeMock.grep.mockClear();
      nativeMock.canonicalize.mockResolvedValue("/repo");
      const ctx = makeContext();
      ctx.getCwd = () => "/repo";
      const execute = buildSearchTools(ctx).grep.execute;
      if (!execute) throw new Error("grep tool execute missing");
      await execute({ pattern: "x", glob }, toolOptions);
      return nativeMock.grep.mock.calls[0]?.[0];
    };
    const bare = await run("src/**/*.ts");
    const list = await run(["src/**/*.ts"]);
    expect(bare).toEqual(list);
    expect(bare).toMatchObject({ glob: ["src/**/*.ts"] });
  });
});

// `grep` runs ripgrep's engine, which has no look-around and no backreferences.
// The model habitually writes PCRE anyway, so the dialect is stated in the
// pattern's own description - and a rejected pattern comes back with the
// rewrite instead of the bare engine error.
describe("grep states the engine's limits", () => {
  const patternDescription = () => {
    const tools = buildSearchTools(makeContext());
    const schema = (
      tools.grep as unknown as {
        inputSchema: { shape: { pattern: { description?: string } } };
      }
    ).inputSchema;
    return schema.shape.pattern.description ?? "";
  };

  it("names the unsupported constructs up front", () => {
    const description = patternDescription();
    expect(description).toContain(SEARCH_PATTERN_HINT);
    expect(description).toContain("look-around");
    expect(description).toContain("backreferences");
  });

  it("explains a rejection instead of returning the raw engine error", async () => {
    nativeMock.canonicalize.mockResolvedValue("/repo");
    nativeMock.grep.mockRejectedValue(
      new Error(
        "regex parse error:\n    foo(?!bar)\nerror: look-around, including " +
          "look-ahead and look-behind, is not supported",
      ),
    );
    const ctx = makeContext();
    ctx.getCwd = () => "/repo";
    const execute = buildSearchTools(ctx).grep.execute;
    if (!execute) throw new Error("grep tool execute missing");
    const result = (await execute({ pattern: "foo(?!bar)" }, toolOptions)) as {
      error: string;
    };
    expect(result.error).toContain("look-around, including look-ahead");
    expect(result.error).toContain("This engine has no look-around");
  });
});
