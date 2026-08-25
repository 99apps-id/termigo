import { describe, expect, it } from "vitest";
import { normalizeLspLocations, buildLspTools } from "./lsp";
import type { ToolContext } from "./context";

function makeContext(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
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
        range: {
          start: { line: 10, character: 4 },
        },
      },
    ];

    const normalized = normalizeLspLocations(raw);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].line).toBe(11);
    expect(normalized[0].character).toBe(5);
    expect(normalized[0].path).toContain("main.ts");
  });

  it("builds LSP tools with proper schemas and auto-execution", () => {
    const ctx = makeContext();
    const tools = buildLspTools(ctx);
    expect(tools.lsp_definitions).toBeDefined();
    expect(tools.lsp_references).toBeDefined();
    expect(tools.lsp_diagnostics).toBeDefined();
  });
});
