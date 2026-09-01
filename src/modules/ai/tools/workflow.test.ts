import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchTool } = vi.hoisted(() => ({
  dispatchTool:
    vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("./tools", () => ({ dispatchTool }));

import {
  listWorkflowNames,
  loadWorkflow,
  runWorkflow,
  type WorkflowDefinition,
} from "./workflow";

function def(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "demo",
    description: "Demo workflow",
    steps: [],
    ...overrides,
  };
}

beforeEach(() => {
  dispatchTool.mockReset().mockResolvedValue({ ok: true });
});

describe("runWorkflow", () => {
  it("runs independent steps in order and returns completed ids", async () => {
    const workflow = def({
      steps: [
        { id: "a", tool: "noop", description: "first" },
        { id: "b", tool: "noop", description: "second" },
      ],
    });

    const result = await runWorkflow(workflow);
    expect(result.workflowName).toBe("demo");
    expect(result.completed).toEqual(["a", "b"]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.stoppedAt).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("respects depends_on ordering", async () => {
    const workflow = def({
      steps: [
        { id: "a", tool: "noop" },
        { id: "b", tool: "noop", depends_on: ["a"] },
        { id: "c", tool: "noop", depends_on: ["b"] },
      ],
    });

    const result = await runWorkflow(workflow);
    expect(result.completed).toEqual(["a", "b", "c"]);
  });

  it("skips downstream steps when a hard dependency fails", async () => {
    const workflow = def({
      steps: [
        { id: "a", tool: "noop" },
        { id: "b", tool: "noop", depends_on: ["a"] },
        { id: "c", tool: "noop", depends_on: ["b"] },
      ],
    });

    const result = await runWorkflow(workflow, {
      a: { ok: false, error: "boom" },
    });
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual(["a"]);
    expect(result.skipped).toEqual(["b", "c"]);
    expect(result.stoppedAt).toBe("a");
  });

  it("continues past soft failures when continue_on_error is set", async () => {
    const workflow = def({
      steps: [
        { id: "a", tool: "noop", continue_on_error: true },
        { id: "b", tool: "noop", depends_on: ["a"], continue_on_error: true },
      ],
    });

    const result = await runWorkflow(workflow, {
      a: { ok: false, error: "soft" },
    });
    expect(result.completed).toEqual(["b"]);
    expect(result.failed).toEqual(["a"]);
    expect(result.skipped).toEqual([]);
    expect(result.stoppedAt).toBeUndefined();
  });

  it("stops and skips dependents when a dispatched tool returns an error", async () => {
    dispatchTool.mockResolvedValueOnce({ error: "approval denied" });
    const result = await runWorkflow(
      def({
        steps: [
          { id: "write", tool: "write_file" },
          { id: "verify", tool: "run_checks", depends_on: ["write"] },
        ],
      }),
    );

    expect(result.failed).toEqual(["write"]);
    expect(result.skipped).toEqual(["verify"]);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
  });
});

describe("loadWorkflow", () => {
  it("returns null when no workspace root is available", async () => {
    expect(await loadWorkflow("anything")).toBeNull();
  });
});

describe("listWorkflowNames", () => {
  it("returns an empty array when no workspace root is available", async () => {
    expect(await listWorkflowNames()).toEqual([]);
  });
});
