import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../lib/native";
import {
  listPipelines,
  loadPipeline,
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
});
