import type { ToolSet } from "ai";
import { stepCountIs } from "ai";
import { describe, expect, it } from "vitest";
import {
  type CircuitBreakerState,
  evaluateCircuitBreaker,
  noErrorProgress,
  noProgressStop,
  noToolRepetition,
  synthesisStepOutcome,
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

  // Command tools (bash_run, git_*, run_checks) report failure as
  // exit_code !== 0 or timed_out: true — NOT an { error } object. Before the
  // fix, a command that failed round after round looked like data and the
  // guard never fired, so the agent retried a failing lint/build forever.
  it("treats a non-zero exit_code as an error", () => {
    const cmdFail: Call = {
      toolName: "bash_run",
      toolCallId: "lint-fail",
      input: { command: "npm run lint" },
      output: {
        command: "npm run lint",
        stdout: "error",
        stderr: "some lint errors",
        exit_code: 1,
        timed_out: false,
      },
    };
    expect(stop(steps([cmdFail], [cmdFail], [cmdFail]))).toBe(true);
  });

  it("treats a timed_out command as an error", () => {
    const timeout: Call = {
      toolName: "bash_run",
      toolCallId: "build-timeout",
      input: { command: "npm run build" },
      output: {
        command: "npm run build",
        stdout: "",
        stderr: "",
        exit_code: null,
        timed_out: true,
      },
    };
    expect(stop(steps([timeout], [timeout], [timeout]))).toBe(true);
  });

  it("does not treat exit_code 0 as an error", () => {
    const ok: Call = {
      toolName: "bash_run",
      toolCallId: "lint-ok",
      input: { command: "npm run lint" },
      output: {
        command: "npm run lint",
        stdout: "clean",
        stderr: "",
        exit_code: 0,
        timed_out: false,
      },
    };
    expect(stop(steps([ok], [ok], [ok]))).toBe(false);
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

describe("synthesisStepOutcome", () => {
  const step = (toolCalls: number, hasText = false) => ({
    toolCalls,
    hasText,
  });

  it("is pending before the synthesis step has run", () => {
    expect(synthesisStepOutcome(3, 3, step(1))).toBe("pending");
    expect(synthesisStepOutcome(2, 3, step(0))).toBe("pending");
  });

  it("is pending when no synthesis was requested", () => {
    expect(synthesisStepOutcome(5, -1, step(2))).toBe("pending");
  });

  it("is a summary when the step after the request has no tool calls", () => {
    expect(synthesisStepOutcome(4, 3, step(0))).toBe("summary");
  });

  it("is a summary when the step produced prose alongside a tool call", () => {
    // The user got a real answer, so this is not the degenerate tool-only loop.
    expect(synthesisStepOutcome(4, 3, step(1, true))).toBe("summary");
  });

  it("is ignored when the step after the request is tool-only", () => {
    // This is the case that used to fall through to the step cap and get
    // auto-continued, replaying the same context into the same tool-only loop.
    expect(synthesisStepOutcome(4, 3, step(1))).toBe("ignored");
    expect(synthesisStepOutcome(4, 3, step(3))).toBe("ignored");
  });
});

describe("evaluateCircuitBreaker", () => {
  const initState: CircuitBreakerState = {
    lastFailedFingerprint: null,
    consecutiveFailureCount: 0,
    activeNudge: null,
  };

  it("does not trip on a single failure", () => {
    const calls = [{ toolName: "bash_run", input: { command: "curl foo" }, toolCallId: "c1" }];
    const results = new Map<string, unknown>([
      ["c1", { exit_code: 1, stderr: "connection refused" }],
    ]);
    const next = evaluateCircuitBreaker(calls, results, initState);
    expect(next.consecutiveFailureCount).toBe(1);
    expect(next.activeNudge).toBeNull();
  });

  it("trips circuit breaker on repeated failure with the same input", () => {
    const calls = [{ toolName: "bash_run", input: { command: "curl foo" }, toolCallId: "c1" }];
    const results = new Map<string, unknown>([
      ["c1", { exit_code: 1, stderr: "connection refused" }],
    ]);
    const first = evaluateCircuitBreaker(calls, results, initState);
    const second = evaluateCircuitBreaker(calls, results, first);
    expect(second.consecutiveFailureCount).toBe(2);
    expect(second.activeNudge).toContain("REPEATED FAILURE DETECTED");
    expect(second.activeNudge).toContain("DO NOT retry the exact same arguments");
  });

  it("trips immediately on command timeout", () => {
    const calls = [{ toolName: "bash_run", input: { command: "npm run dev" }, toolCallId: "c1" }];
    const results = new Map<string, unknown>([
      ["c1", { timed_out: true, exit_code: null }],
    ]);
    const next = evaluateCircuitBreaker(calls, results, initState);
    expect(next.activeNudge).toContain("COMMAND TIMED OUT");
    expect(next.activeNudge).toContain("bash_background");
  });

  it("trips immediately when tool reports environment is offline", () => {
    const calls = [{ toolName: "web_search", input: { query: "vitest docs" }, toolCallId: "c1" }];
    const results = new Map<string, unknown>([
      ["c1", { error: "Network connection unavailable", isOffline: true }],
    ]);
    const next = evaluateCircuitBreaker(calls, results, initState);
    expect(next.activeNudge).toContain("ENVIRONMENT IS OFFLINE");
    expect(next.activeNudge).toContain("DO NOT attempt any further web searches");
  });

  it("clears circuit breaker when a step succeeds", () => {
    const calls = [{ toolName: "bash_run", input: { command: "npm run dev" }, toolCallId: "c1" }];
    const timeoutResults = new Map<string, unknown>([
      ["c1", { timed_out: true }],
    ]);
    const timedOut = evaluateCircuitBreaker(calls, timeoutResults, initState);
    expect(timedOut.activeNudge).not.toBeNull();

    const successCalls = [{ toolName: "read_file", input: { path: "package.json" }, toolCallId: "c2" }];
    const successResults = new Map<string, unknown>([
      ["c2", "{\"name\": \"termigo\"}"],
    ]);
    const cleared = evaluateCircuitBreaker(successCalls, successResults, timedOut);
    expect(cleared.activeNudge).toBeNull();
    expect(cleared.consecutiveFailureCount).toBe(0);
  });
});

// The evidence this bundle is written against, from the trajectory store:
//
//   run-mtxsloul-t1o6ba  status=failed  steps=8
//     read_file, read_file, read_file, read_file, grep,
//     read_file, read_file, read_file       <- all success, all different
//   run-mtxsipep-0x5p4o  status=failed  steps=6
//     read_file x5, glob                    <- all success
//
// Two runs of ordinary multi-file exploration, terminated by a guard, after
// burning 199k and 75k tokens. The guard was a prose-free streak: two
// consecutive steps that called tools without emitting text requested a
// synthesis step, and the synthesis step ended the run either way. Reading
// eight files emits no prose between them, so the guard fired on work that was
// succeeding.
//
// It has been removed. A streak of prose-free tool steps is NOT a loop, and
// this locks that: the predicates the run actually composes must all stay
// quiet through the recorded shape.
describe("a prose-free run of successful, varied tools is not a loop", () => {
  /** The recorded shape: 8 steps, one tool each, all different, all success. */
  const variedWork = () => {
    const paths = [
      "src/App.tsx",
      "src/main.tsx",
      "src/lib/utils.ts",
      "package.json",
      "vite.config.ts",
      "src/app/App.tsx",
      "src/modules/tabs/store.ts",
      "tsconfig.json",
    ];
    const calls: Call[][] = paths.map((path, i) =>
      i === 4
        ? [
            {
              toolName: "grep",
              toolCallId: "g1",
              input: { pattern: "export" },
              output: "src/a.ts:1:export {}",
            },
          ]
        : [read(path, `contents of ${path}`)],
    );
    return steps(...calls);
  };

  it("is not flagged as repetition", () => {
    expect(noToolRepetition<ToolSet>(3)(variedWork())).toBe(false);
  });

  it("is not flagged as no-progress, because every step called a tool", () => {
    expect(noProgressStop<ToolSet>(2)(variedWork())).toBe(false);
  });

  it("is not flagged as repeated failure", () => {
    expect(noErrorProgress<ToolSet>(3)(variedWork())).toBe(false);
  });

  it("does not stop before the step budget", () => {
    expect(stepCountIs(25)(variedWork())).toBe(false);
  });

  it("stops only at the step budget, well past the recorded runs", () => {
    // The recorded runs died at 6 and 8 steps. The cap is what should end a
    // long run, and it must not be reached at 8.
    expect(stepCountIs(8)(variedWork())).toBe(true);
    expect(stepCountIs(12)(variedWork())).toBe(false);
  });

  it("still catches the loop it was meant to catch", () => {
    // The guard is gone, not the protection: the same read three times is
    // repetition and must trip.
    expect(
      noToolRepetition<ToolSet>(3)(
        steps([read("a", "v")], [read("a", "v")], [read("a", "v")]),
      ),
    ).toBe(true);
  });
});
