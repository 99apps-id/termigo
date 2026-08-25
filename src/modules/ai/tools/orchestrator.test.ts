import { describe, expect, it } from "vitest";
import { loadPipeline, listPipelines } from "../lib/orchestrator";

describe("orchestrator", () => {
  it("returns empty results when no pipelines exist", async () => {
    const pipelines = await listPipelines();
    expect(pipelines).toEqual([]);
  });

  it("returns null for missing pipeline", async () => {
    const result = await loadPipeline("nonexistent");
    expect(result).toBeNull();
  });
});
