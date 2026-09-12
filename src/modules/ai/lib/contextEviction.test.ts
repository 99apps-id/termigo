import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { evictObsoleteToolOutputs } from "./contextEviction";

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
            output: {
              type: "text",
              value:
                "console.log('version 1 - very long source code content');",
              path: "src/main.ts",
            },
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
            output: {
              type: "text",
              value: "console.log('version 2 - latest updated content');",
              path: "src/main.ts",
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(1);
    expect(result.summary.estimatedTokensSaved).toBeGreaterThan(0);

    // biome-ignore lint/suspicious/noExplicitAny: tool content shape is SDK-typed, cast to read part fields
    const firstToolPart = (result.messages[1].content as any)[0];
    // biome-ignore lint/suspicious/noExplicitAny: tool content shape is SDK-typed, cast to read part fields
    const secondToolPart = (result.messages[3].content as any)[0];

    expect(firstToolPart.output.value).toContain("evicted to save context");
    expect(secondToolPart.output.value).toBe(
      "console.log('version 2 - latest updated content');",
    );
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
              value: {
                path: "src/main.ts",
                content: "old content, long enough to matter",
              },
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

    // biome-ignore lint/suspicious/noExplicitAny: tool content shape is SDK-typed, cast to read part fields
    const first = (result.messages[0].content as any)[0];
    // biome-ignore lint/suspicious/noExplicitAny: tool content shape is SDK-typed, cast to read part fields
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
    // biome-ignore lint/suspicious/noExplicitAny: tool content shape is SDK-typed, cast to read part fields
    expect((result.messages[0].content as any)[0].output.value.stdout).toBe(
      "ok",
    );
  });

  it("evicts stale duplicate reads inside ONE collapsed message", () => {
    // An auto-continuing turn collapses its whole tool history into a single
    // tool message (the 0.9.10 log shape: 15 read_file parts in one 24 KB
    // message). Dedupe must work PART-WISE inside that array, not just across
    // messages — the older copy of the same path is dead weight even when both
    // results sit in the same message.
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: {
              type: "json",
              value: {
                path: "src/main.ts",
                content: "old copy, long enough to matter here",
              },
            },
          },
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "read_file",
            output: {
              type: "json",
              value: { path: "src/main.ts", content: "new copy" },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: tool content shape is SDK-typed, cast to read part fields
    const parts = result.messages[0].content as any[];
    // Walking backwards keeps the NEWEST (c2) intact and evicts the older (c1).
    expect(parts[0].output.value).toContain("evicted to save context");
    expect(parts[1].output.value.content).toBe("new copy");
  });

  function twoReadsOfTheSamePath(secondValue: unknown): ModelMessage[] {
    return [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: {
              type: "json",
              value: { path: "src/main.ts", content: "old copy" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "read_file",
            output: { type: "json", value: secondValue },
          },
        ],
      },
    ] as unknown as ModelMessage[];
  }

  it("returns the caller's array untouched when nothing is evicted", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: { type: "json", value: { path: "only.ts", content: "x" } },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(0);
    // The same array, not an equal copy: a fresh identity on every model call
    // re-runs anything memoised on the transcript, for no eviction at all.
    expect(result.messages).toBe(messages);
  });

  it("never writes into the caller's transcript", () => {
    const messages = twoReadsOfTheSamePath({
      path: "src/main.ts",
      content: "new copy",
    });
    const before = JSON.stringify(messages);

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(1);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("keeps values a JSON round-trip cannot carry", () => {
    // The kept part is copied, not serialised, so a Uint8Array (image data on a
    // tool result) survives as the same object instead of becoming { 0: 1, ... }.
    const bytes = new Uint8Array([1, 2, 3]);
    const messages = twoReadsOfTheSamePath({
      path: "src/main.ts",
      bytes,
    });

    const result = evictObsoleteToolOutputs(messages);
    expect(result.summary.evictedToolCalls).toBe(1);
    const kept = result.messages[1].content as unknown as Array<{
      output: { value: { bytes: Uint8Array } };
    }>;
    expect(kept[0].output.value.bytes).toBe(bytes);
  });
});
