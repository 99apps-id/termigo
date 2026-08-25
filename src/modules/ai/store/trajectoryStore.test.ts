import { describe, expect, it, beforeEach } from "vitest";
import { useTrajectoryStore } from "./trajectoryStore";

describe("trajectoryStore", () => {
  beforeEach(() => {
    useTrajectoryStore.getState().clearRuns();
  });

  it("starts a run and appends execution steps correctly", () => {
    const store = useTrajectoryStore.getState();
    store.startRun({ runId: "run-1", modelId: "gemini-2.5-flash", taskId: "test-task" });

    store.appendStep({
      id: "step-1",
      stepIndex: 0,
      toolName: "read_file",
      args: { path: "src/main.ts" },
      status: "running",
    });

    const activeRun = useTrajectoryStore.getState().runs.find((r) => r.runId === "run-1");
    expect(activeRun).toBeDefined();
    expect(activeRun?.steps).toHaveLength(1);
    expect(activeRun?.steps[0].toolName).toBe("read_file");

    store.updateStep("step-1", { status: "success", durationMs: 120 });
    const updated = useTrajectoryStore.getState().runs.find((r) => r.runId === "run-1");
    expect(updated?.steps[0].status).toBe("success");
    expect(updated?.steps[0].durationMs).toBe(120);
  });
});
