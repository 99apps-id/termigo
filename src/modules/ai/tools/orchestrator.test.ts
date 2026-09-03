import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../lib/native";
import {
  listPipelines,
  loadPipeline,
  runPipeline,
  runPipelineByName,
} from "../lib/orchestrator";

const { sendMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock("../store/chatRuntime", () => ({ sendMessage }));

const PIPELINE_JSON = JSON.stringify({
  id: "release",
  name: "Release",
  description: "Release checklist",
  steps: [
    { id: "verify", type: "general", prompt: "Run checks" },
    { id: "commit", type: "general", prompt: "Commit", depends_on: ["verify"] },
  ],
});

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("orchestrator", () => {
  it("returns empty results when no pipelines exist", async () => {
    const pipelines = await listPipelines();
    expect(pipelines).toEqual([]);
  });

  it("returns null for missing pipeline", async () => {
    const result = await loadPipeline("nonexistent");
    expect(result).toBeNull();
  });

  it("loads a pipeline from .termigo/pipelines", async () => {
    vi.spyOn(native, "readFile").mockResolvedValue({
      kind: "text",
      content: PIPELINE_JSON,
      size: PIPELINE_JSON.length,
    });
    const pipeline = await loadPipeline("release");
    expect(pipeline).not.toBeNull();
    expect(pipeline?.steps).toHaveLength(2);
  });
});

describe("runPipelineByName", () => {
  it("refuses an unknown pipeline", async () => {
    const result = await runPipelineByName("nope");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends an orchestrate prompt for a known pipeline", async () => {
    vi.spyOn(native, "readFile").mockResolvedValue({
      kind: "text",
      content: PIPELINE_JSON,
      size: PIPELINE_JSON.length,
    });
    const result = await runPipelineByName("release");
    expect(result).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = sendMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('pipeline "release"');
    expect(prompt).toContain("orchestrate");
    expect(prompt).toContain("2 steps");
  });

  it("reports a failure when nothing can be sent", async () => {
    vi.spyOn(native, "readFile").mockResolvedValue({
      kind: "text",
      content: PIPELINE_JSON,
      size: PIPELINE_JSON.length,
    });
    sendMessage.mockResolvedValue(false);
    const result = await runPipelineByName("release");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no active chat/);
  });

  it("stops pipeline execution and skips pending steps when a sequential step fails", async () => {
    const pipeline = {
      id: "failing-pipe",
      name: "Failing Pipe",
      steps: [
        { id: "step1", type: "general" as const, prompt: "First step" },
        { id: "step2", type: "general" as const, prompt: "Second independent step" },
      ],
    };
    const mockContext = {
      getCwd: () => ".",
      getWorkspaceRoot: () => ".",
      getRemoteSession: () => null,
      getTerminalContext: () => null,
      isActiveTerminalPrivate: () => false,
      injectIntoActivePty: () => false,
      openPreview: () => false,
      openCanvas: () => false,
      browserOpen: async () => ({ error: "disabled" }),
      browserNavigate: async () => ({ error: "disabled" }),
      browserBack: async () => ({ error: "disabled" }),
      browserForward: async () => ({ error: "disabled" }),
      browserReload: async () => ({ error: "disabled" }),
      browserExtract: async () => ({ error: "disabled" }),
      browserEval: async () => ({ error: "disabled" }),
      browserScreenshot: async () => ({ error: "disabled" }),
      browserConsole: async () => ({ error: "disabled" }),
      browserUrl: async () => ({ error: "disabled" }),
      browserClose: async () => ({ error: "disabled" }),
      browserList: async () => [],
      spawnAgent: () => null,
      readAgentOutput: () => null,
      readCache: new Map(),
      getSessionId: () => "sid",
    };
    const result = await runPipeline(pipeline, mockContext);
    expect(result.stoppedAt).toBe("step1");
    expect(result.failed).toContain("step1");
    expect(result.skipped).toContain("step2");
    expect(result.completed).toEqual([]);
  });
});
