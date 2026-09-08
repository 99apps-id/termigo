import { describe, expect, it, vi } from "vitest";
import { buildImageGenerationTools } from "./imageGeneration";
import type { ToolContext } from "./context";

vi.mock("../store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      apiKeys: {},
      selectedModelId: "gpt-4o",
    }),
  },
}));

vi.mock("../lib/native", () => ({
  native: {
    canonicalize: vi.fn(async (p: string) => p),
    writeFileBase64: vi.fn(async () => 1234),
  },
}));

vi.mock("../lib/security", () => ({
  checkWritableCanonical: vi.fn(async (p: string) => ({ ok: true, canonical: p })),
}));

function mockCtx(): ToolContext {
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
    getSessionId: () => "sess-1",
  } as unknown as ToolContext;
}

describe("imageGeneration tool", () => {
  it("defines generate_image tool with correct schema", () => {
    const tools = buildImageGenerationTools(mockCtx());
    expect(tools.generate_image).toBeDefined();

    const parsed = tools.generate_image.inputSchema.parse({
      prompt: "A beautiful sunset over mountains",
      aspect_ratio: "16:9",
    });
    expect(parsed.prompt).toBe("A beautiful sunset over mountains");
    expect(parsed.aspect_ratio).toBe("16:9");
  });

  it("returns clear error when no image provider API key is configured", async () => {
    const tools = buildImageGenerationTools(mockCtx());
    const execute = tools.generate_image.execute;
    if (!execute) throw new Error("execute not defined");

    const result = (await execute(
      {
        prompt: "Futuristic spaceship",
      },
      { toolCallId: "call-1", messages: [] } as never,
    )) as { error?: string };

    expect(result.error).toContain("No image generation provider configured");
  });
});
