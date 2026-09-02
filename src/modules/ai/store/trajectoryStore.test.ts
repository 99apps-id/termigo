import { beforeEach, describe, expect, it } from "vitest";
import { useTrajectoryStore } from "./trajectoryStore";

describe("trajectoryStore", () => {
  beforeEach(() => {
    useTrajectoryStore.getState().clearRuns();
  });

  it("starts a run and appends execution steps correctly", () => {
    const store = useTrajectoryStore.getState();
    store.startRun({
      runId: "run-1",
      modelId: "gemini-2.5-flash",
      taskId: "test-task",
    });

    store.appendStep({
      id: "step-1",
      stepIndex: 0,
      toolName: "read_file",
      args: { path: "src/main.ts" },
      status: "running",
    });

    const activeRun = useTrajectoryStore
      .getState()
      .runs.find((r) => r.runId === "run-1");
    expect(activeRun).toBeDefined();
    expect(activeRun?.steps).toHaveLength(1);
    expect(activeRun?.steps[0].toolName).toBe("read_file");

    store.updateStep("step-1", { status: "success", durationMs: 120 });
    const updated = useTrajectoryStore
      .getState()
      .runs.find((r) => r.runId === "run-1");
    expect(updated?.steps[0].status).toBe("success");
    expect(updated?.steps[0].durationMs).toBe(120);
  });

  it("closes a leftover running step as error when the run finishes", () => {
    // A call whose round died before producing a result (validation reject,
    // abort mid-execute) used to stay "running" forever — a card the user
    // read as "waiting for my answer" when nothing was waiting.
    const store = useTrajectoryStore.getState();
    store.startRun({ runId: "run-2", modelId: "m" });
    store.appendStep({
      id: "step-a",
      stepIndex: 0,
      toolName: "ask_user",
      args: {},
      status: "running",
    });
    store.appendStep({
      id: "step-b",
      stepIndex: 1,
      toolName: "read_file",
      args: {},
      status: "success",
    });
    store.finishRun({ status: "failed" });
    const run = useTrajectoryStore
      .getState()
      .runs.find((r) => r.runId === "run-2");
    expect(run?.steps[0].status).toBe("error");
    expect(run?.steps[1].status).toBe("success");
  });
});
