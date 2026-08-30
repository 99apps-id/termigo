import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
  noErrorProgress,
  noProgressStop,
  noToolRepetition,
  synthesisStopDecision,
} from "./agent";

type Call = {
  toolName: string;
  toolCallId: string;
  input: unknown;
  /** The output the tool returned, folded into the repetition fingerprint. */
  output?: unknown;
};

/** Minimal stand-in for the SDK's StepResult: the predicates only read
 *  `toolCalls` and `toolResults`. The results are derived from the same call
 *  array so a step that reads a file carries the content it got back. */
function steps(...calls: (Call[] | null)[]) {
  return {
    steps: calls.map((c) => ({
      toolCalls: (c ?? []).map(({ toolCallId, toolName, input }) => ({
        toolCallId,
        toolName,
        input,
      })),
      toolResults: (c ?? []).map(({ toolCallId, toolName, output }) => ({
        toolCallId,
        toolName,
        output,
      })),
    })),
  } as unknown as Parameters<ReturnType<typeof noToolRepetition<ToolSet>>>[0];
}

const read = (path: string, content = ""): Call => ({
  toolName: "read_file",
  toolCallId: `read-${path}`,
  input: { path },
  output: content,
});

describe("noToolRepetition", () => {
  const stop = noToolRepetition<ToolSet>(3);

  it("does not fire before there are enough steps", () => {
    expect(stop(steps([read("a")], [read("a")]))).toBe(false);
  });

  it("fires on the same tool with the same input three times", () => {
    expect(stop(steps([read("a")], [read("a")], [read("a")]))).toBe(true);
  });

  it("ignores a differing argument", () => {
    expect(stop(steps([read("a")], [read("a")], [read("b")]))).toBe(false);
  });

  it("treats key order as equivalent, not as progress", () => {
    const one: Call = {
      toolName: "edit",
      toolCallId: "one",
      input: { path: "x", body: "y" },
    };
    const two: Call = {
      toolName: "edit",
      toolCallId: "two",
      input: { body: "y", path: "x" },
    };
    expect(stop(steps([one], [two], [one]))).toBe(true);
  });

  it("compares the whole parallel call set, not just the first", () => {
    const a = [read("a"), read("b")];
    const b = [read("a"), read("c")];
    expect(stop(steps(a, a, a))).toBe(true);
    expect(stop(steps(a, a, b))).toBe(false);
  });

  it("fires on an alternating loop, not just consecutive repeats", () => {
    // read a, read b, read a, read b, read a: no two consecutive steps are
    // identical, but the same call recurs 3x inside the window. This is the
    // loop the old tail check let burn the whole step budget.
    expect(
      stop(
        steps([read("a")], [read("b")], [read("a")], [read("b")], [read("a")]),
      ),
    ).toBe(true);
  });

  it("allows a call that recurs twice in the window", () => {
    // Two reads of the same file is legitimate work; three is a loop.
    expect(
      stop(steps([read("a")], [read("b")], [read("a")], [read("c")])),
    ).toBe(false);
  });

  it("allows read -> edit -> read (verify) because the result changed", () => {
    // The same read_file call recurs three times, but each read returns the
    // file as it is after the intervening edit, so the results differ. Same
    // call with changed output is progress, not a loop.
    expect(
      stop(
        steps(
          [read("a", "v1")],
          [
            {
              toolName: "edit",
              toolCallId: "edit-a",
              input: { path: "a", body: "v2" },
              output: { ok: true },
            },
          ],
          [read("a", "v2")],
        ),
      ),
    ).toBe(false);
  });

  it("fires when a read keeps returning the same unchanged content", () => {
    // The model keeps re-reading a file that never changes: same call, same
    // result - that is a loop, not verification.
    expect(
      stop(
        steps(
          [read("a", "v")],
          [read("b", "w")],
          [read("a", "v")],
          [read("b", "w")],
          [read("a", "v")],
        ),
      ),
    ).toBe(true);
  });

  it("never fires on a step that called no tool", () => {
    expect(stop(steps([read("a")], null, [read("a")]))).toBe(false);
  });
});

describe("noProgressStop", () => {
  const stop = noProgressStop<ToolSet>(2);

  it("fires after two consecutive text-only steps", () => {
    expect(stop(steps(null, null))).toBe(true);
  });

  it("does not fire while the agent is still calling tools", () => {
    expect(stop(steps(null, [read("a")]))).toBe(false);
    expect(stop(steps([read("a")], null))).toBe(false);
  });

  it("does not fire on a single step", () => {
    expect(stop(steps(null))).toBe(false);
  });
});

describe("noErrorProgress", () => {
  const stop = noErrorProgress<ToolSet>(3);
  const fail = (tool: string, msg = "boom"): Call => ({
    toolName: tool,
    toolCallId: `${tool}-fail`,
    input: tool === "bash_run" ? { command: "x" } : { path: "/x" },
    output: { error: msg },
  });

  it("does not fire before there are enough steps", () => {
    expect(stop(steps([fail("bash_run")], [fail("bash_run")]))).toBe(false);
  });

  it("fires after three consecutive all-error steps", () => {
    expect(
      stop(steps([fail("bash_run")], [fail("bash_run")], [fail("bash_run")])),
    ).toBe(true);
  });

  it("does not fire when a step returned a real result", () => {
    expect(
      stop(
        steps(
          [fail("bash_run")],
          [fail("bash_run")],
          [
            {
              toolName: "bash_run",
              toolCallId: "ok",
              input: { command: "x" },
              output: "done",
            },
          ],
        ),
      ),
    ).toBe(false);
  });

  it("does not fire on a step that called no tool", () => {
    expect(stop(steps(null, [fail("bash_run")], [fail("bash_run")]))).toBe(
      false,
    );
  });

  it("requires every call in a batch to error, not just one", () => {
    const batch = [
      fail("bash_run"),
      {
        toolName: "read_file",
        toolCallId: "read-ok",
        input: { path: "/x" },
        output: "data",
      },
    ];
    expect(stop(steps(batch, batch, batch))).toBe(false);
  });
});

describe("synthesisStopDecision", () => {
  it("stops immediately when the model cannot take a forced tool choice", () => {
    expect(synthesisStopDecision(false, false)).toEqual({
      stop: true,
      requested: false,
    });
  });

  it("holds the stop for one synthesis step on the first trip", () => {
    expect(synthesisStopDecision(true, false)).toEqual({
      stop: false,
      requested: true,
    });
  });

  it("stops once the synthesis step has already been requested", () => {
    expect(synthesisStopDecision(true, true)).toEqual({
      stop: true,
      requested: true,
    });
  });
});
