import { describe, expect, it } from "vitest";
import type { ToolExecutionOptions } from "ai";
import { normalizeLspLocations, buildLspTools } from "./lsp";
import type { ToolContext } from "./context";

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

describe("lsp tools", () => {
  it("normalizes LSP locations correctly", () => {
    const raw = [
      {
        uri: "file:///workspace/src/main.ts",
        range: { start: { line: 10, character: 4 } },
      },
    ];

    const normalized = normalizeLspLocations(raw);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].line).toBe(11);
    expect(normalized[0].character).toBe(5);
    expect(normalized[0].path).toContain("main.ts");
  });

  it("normalizes LocationLink targets", () => {
    const raw = [
      {
        targetUri: "file:///workspace/src/lib.ts",
        targetRange: { start: { line: 0, character: 0 } },
        targetSelectionRange: { start: { line: 2, character: 1 } },
      },
    ];
    const normalized = normalizeLspLocations(raw);
    expect(normalized[0].line).toBe(3);
    expect(normalized[0].character).toBe(2);
  });

  it("returns empty array for null input", () => {
    expect(normalizeLspLocations(null)).toEqual([]);
  });

  it("builds LSP tools with proper schemas", () => {
    const ctx = makeContext();
    const tools = buildLspTools(ctx);
    expect(tools.lsp_definitions).toBeDefined();
    expect(tools.lsp_references).toBeDefined();
    expect(tools.lsp_diagnostics).toBeDefined();
  });

  it("lsp_definitions returns a clear error when no server covers the file", async () => {
    const ctx = makeContext();
    const tools = buildLspTools(ctx);
    const execute = tools.lsp_definitions.execute;
    if (!execute) throw new Error("execute missing");
    const result = (await execute(
      { path: "/workspace/README.md", line: 1, character: 1 },
      toolOptions,
    )) as { error?: string };
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("language server");
  });

  it("lsp_diagnostics reads from the editor's live diagnostics store", async () => {
    const ctx = makeContext();
    const tools = buildLspTools(ctx);
    const execute = tools.lsp_diagnostics.execute;
    if (!execute) throw new Error("execute missing");

    const result = (await execute(
      { path: "/workspace/src/main.ts" },
      toolOptions,
    )) as { diagnostics?: unknown[]; count?: number; note?: string };
    expect(result.diagnostics).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.note).toContain("run_checks");
  });
});