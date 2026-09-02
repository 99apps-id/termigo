import { describe, expect, it } from "vitest";
import { subagentMadeProgress } from "./subagentProgress";

describe("subagentMadeProgress", () => {
  it("is false for the empty-completion shape (one step, nothing in it)", () => {
    expect(subagentMadeProgress({ steps: [{}] })).toBe(false);
    expect(subagentMadeProgress({})).toBe(false);
  });

  it("is true when a step issued a tool call", () => {
    expect(
      subagentMadeProgress({
        steps: [{ toolCalls: [{ toolName: "bash_run" }] }],
      }),
    ).toBe(true);
  });

  it("is true when a step produced a tool result", () => {
    expect(
      subagentMadeProgress({ steps: [{ toolResults: [{ output: "x" }] }] }),
    ).toBe(true);
  });

  it("is true when any step in a multi-step run did work", () => {
    expect(
      subagentMadeProgress({
        steps: [{}, {}, { toolCalls: [{ toolName: "read_file" }] }],
      }),
    ).toBe(true);
  });
});
