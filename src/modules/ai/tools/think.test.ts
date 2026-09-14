import type { ToolExecutionOptions } from "ai";
import { describe, expect, it } from "vitest";
import { buildThinkTools } from "./think";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

describe("think tool", () => {
  it("records thoughts without side effects and returns metadata", async () => {
    const tools = buildThinkTools();
    expect(tools.think).toBeDefined();

    const thoughts = "Need to test edge case where file does not exist";
    const result = (await tools.think.execute(
      { thoughts },
      toolOptions,
    )) as { ok: boolean; recorded: boolean; length: number };

    expect(result.ok).toBe(true);
    expect(result.recorded).toBe(true);
    expect(result.length).toBe(thoughts.length);
  });
});
