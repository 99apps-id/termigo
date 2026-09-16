import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const nativeMock = vi.hoisted(() => ({
  canonicalize: vi.fn(async (path: string) => path),
  grep: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("../lib/native", () => ({
  native: nativeMock,
}));

import { buildReplaceTools } from "./replace";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
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

describe("replace_in_files glob input schema", () => {
  beforeEach(() => {
    nativeMock.grep.mockReset();
    nativeMock.readTextFile.mockReset();
    nativeMock.writeTextFile.mockReset();
  });

  it("parses a single string glob", () => {
    const tools = buildReplaceTools(makeContext());
    const parsed = tools.replace_in_files.inputSchema.parse({
      search: "foo",
      replace: "bar",
      glob: "src-tauri/src/modules/pty/mod.rs",
    }) as { glob?: string | string[] };
    expect(parsed.glob).toBe("src-tauri/src/modules/pty/mod.rs");
  });

  it("parses an array of glob strings", () => {
    const tools = buildReplaceTools(makeContext());
    const parsed = tools.replace_in_files.inputSchema.parse({
      search: "foo",
      replace: "bar",
      glob: ["**/*.ts", "src/**/*.tsx"],
    }) as { glob?: string | string[] };
    expect(parsed.glob).toEqual(["**/*.ts", "src/**/*.tsx"]);
  });

  it("normalizes a single string glob to array on execution", async () => {
    const tools = buildReplaceTools(makeContext());
    const execute = tools.replace_in_files.execute;
    if (!execute) throw new Error("replace_in_files execute missing");

    nativeMock.grep.mockResolvedValue({
      hits: [],
      truncated: false,
      files_scanned: 1,
    });

    await execute(
      {
        search: "AtomicU32",
        replace: "AtomicU64",
        glob: "src-tauri/src/modules/pty/mod.rs",
      },
      toolOptions,
    );

    expect(nativeMock.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        glob: ["src-tauri/src/modules/pty/mod.rs"],
      }),
    );
  });
});
