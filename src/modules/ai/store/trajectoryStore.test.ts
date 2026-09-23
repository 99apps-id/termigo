import { beforeEach, describe, expect, it } from "vitest";
import { MAX_RUNS } from "../lib/trajectoryIo";
import { capStepOutput, useTrajectoryStore } from "./trajectoryStore";

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

  it("marks leftover running steps as awaiting-approval when run pauses on tool-calls", () => {
    const store = useTrajectoryStore.getState();
    store.startRun({ runId: "run-3", modelId: "m" });
    store.appendStep({
      id: "step-bash",
      stepIndex: 0,
      toolName: "bash_run",
      args: { command: "sudo ufw status" },
      status: "running",
    });
    store.finishRun({ status: "completed", finishReason: "tool-calls" });
    const run = useTrajectoryStore
      .getState()
      .runs.find((r) => r.runId === "run-3");
    expect(run?.steps[0].status).toBe("awaiting-approval");
    expect(run?.steps[0].output).toBeUndefined();
  });

  it("reconciles a previous run's awaiting-approval step when a new run starts", () => {
    // An approval-gated round ends with its tool call marked
    // "awaiting-approval"; the call then RUNS in the next round, so the old
    // card must stop claiming the agent waits for a click once that round
    // begins. Without this the replay timeline is a field of ghost cards.
    const store = useTrajectoryStore.getState();
    store.startRun({ runId: "run-old", modelId: "m" });
    store.appendStep({
      id: "step-old",
      stepIndex: 0,
      toolName: "bash_run",
      args: { command: "npm run build" },
      status: "running",
    });
    store.finishRun({ status: "completed", finishReason: "tool-calls" });
    expect(
      useTrajectoryStore.getState().runs.find((r) => r.runId === "run-old")
        ?.steps[0].status,
    ).toBe("awaiting-approval");

    useTrajectoryStore.getState().startRun({ runId: "run-new", modelId: "m" });
    const old = useTrajectoryStore
      .getState()
      .runs.find((r) => r.runId === "run-old");
    expect(old?.steps[0].status).toBe("success");
    // The new run is untouched; a genuinely running pause is never rewritten.
    expect(useTrajectoryStore.getState().activeRunId).toBe("run-new");
  });

  it("keeps the in-memory run list bounded like the persisted one", () => {
    const store = useTrajectoryStore.getState();
    for (let i = 0; i < MAX_RUNS + 20; i++) {
      store.startRun({ runId: `run-${i}`, modelId: "m" });
      store.finishRun({ status: "completed" });
    }
    const { runs } = useTrajectoryStore.getState();
    expect(runs.length).toBeLessThanOrEqual(MAX_RUNS);
    // The NEWEST runs survive — the replay timeline is read top-down in time.
    expect(runs[runs.length - 1].runId).toBe(`run-${MAX_RUNS + 19}`);
  });
});

describe("capStepOutput", () => {
  it("passes non-strings and small strings through by reference", () => {
    const obj = { stdout: "ok" };
    expect(capStepOutput(obj)).toBe(obj);
    expect(capStepOutput("small")).toBe("small");
    expect(capStepOutput(undefined)).toBeUndefined();
  });

  it("truncates an oversized string, keeping head and tail", () => {
    const big = "A".repeat(100_000) + "B".repeat(100_000) + "C".repeat(100_000);
    const capped = capStepOutput(big) as string;
    expect(capped.length).toBeLessThan(big.length);
    expect(capped.startsWith("A")).toBe(true);
    expect(capped.endsWith("C")).toBe(true);
    expect(capped).toContain("truncated for trajectory retention");
  });

  it("caps the output a step is updated with", () => {
    const store = useTrajectoryStore.getState();
    store.startRun({ runId: "run-cap", modelId: "m" });
    store.appendStep({
      id: "step-cap",
      stepIndex: 0,
      toolName: "read_file",
      args: {},
      status: "running",
    });
    store.updateStep("step-cap", {
      status: "success",
      output: "z".repeat(500_000),
    });
    const run = useTrajectoryStore
      .getState()
      .runs.find((r) => r.runId === "run-cap");
    const out = run?.steps[0].output as string;
    expect(out.length).toBeLessThan(200_000);
    expect(out).toContain("truncated for trajectory retention");
  });
});
