import { describe, expect, it } from "vitest";
import { evictObsoleteToolOutputs } from "./contextEviction";
import type { ModelMessage } from "ai";

describe("contextEviction", () => {
  it("evicts older read_file outputs while keeping the latest read intact", () => {
    const messages = [
      {
        role: "user",
        content: "Please check src/main.ts and update it",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "src/main.ts" },
            output: { type: "text", value: "console.log('version 1 - very long source code content');", path: "src/main.ts" },
          },
        ],
      },
      {
        role: "assistant",
        content: "I will edit the file and read it again.",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "read_file",
            input: { path: "src/main.ts" },
            output: { type: "text", value: "console.log('version 2 - latest updated content');", path: "src/main.ts" },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(1);
    expect(result.summary.estimatedTokensSaved).toBeGreaterThan(0);

    const firstToolPart = (result.messages[1].content as any)[0];
    const secondToolPart = (result.messages[3].content as any)[0];

    expect(firstToolPart.output.value).toContain("evicted to save context");
    expect(secondToolPart.output.value).toBe("console.log('version 2 - latest updated content');");
  });

  it("finds the path inside SDK-wrapped outputs ({ type: 'json', value })", () => {
    // convertToModelMessages drops `input` and wraps the result, so the path
    // only exists at output.value.path. This is the shape eviction sees in
    // the real flow; the old key (input.path || output.path) matched nothing
    // here and made the whole feature dead code.
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: {
              type: "json",
              value: { path: "src/main.ts", content: "old content, long enough to matter" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "read_file",
            output: {
              type: "json",
              value: { path: "src/main.ts", content: "new content" },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(1);

    const first = (result.messages[0].content as any)[0];
    const second = (result.messages[1].content as any)[0];
    expect(first.output.value).toContain("evicted to save context");
    expect(second.output.value.content).toBe("new content");
  });

  it("leaves unrelated tool results untouched", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash_run",
            output: { type: "json", value: { stdout: "ok" } },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(0);
    expect((result.messages[0].content as any)[0].output.value.stdout).toBe("ok");
  });
});
