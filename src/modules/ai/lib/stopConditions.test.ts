import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { noProgressStop, noToolRepetition } from "./agent";

type Call = { toolName: string; input: unknown };

/** Minimal stand-in for the SDK's StepResult: the predicates only read
 *  `toolCalls`. */
function steps(...calls: (Call[] | null)[]) {
  return {
    steps: calls.map((c) => ({ toolCalls: c ?? [] })),
  } as unknown as Parameters<ReturnType<typeof noToolRepetition<ToolSet>>>[0];
}

const read = (path: string): Call => ({ toolName: "read_file", input: { path } });

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
    const one: Call = { toolName: "edit", input: { path: "x", body: "y" } };
    const two: Call = { toolName: "edit", input: { body: "y", path: "x" } };
    expect(stop(steps([one], [two], [one]))).toBe(true);
  });

  it("compares the whole parallel call set, not just the first", () => {
    const a = [read("a"), read("b")];
    const b = [read("a"), read("c")];
    expect(stop(steps(a, a, a))).toBe(true);
    expect(stop(steps(a, a, b))).toBe(false);
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
