import { describe, expect, it } from "vitest";
import { repairJsonText, repairToolCall } from "./repairToolCall";

describe("repairJsonText", () => {
  it("leaves already-valid JSON untouched", () => {
    const input = '{"tasks":[{"type":"read","prompt":"hi"}]}';
    expect(repairJsonText(input)).toBe(input);
  });

  it("escapes an unescaped double quote inside a string value", () => {
    const input = '{"prompt":"audit "route.ts" file"}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).prompt).toBe('audit "route.ts" file');
  });

  it("escapes a literal newline inside a string value", () => {
    const input = '{"prompt":"line1\nline2"}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).prompt).toBe("line1\nline2");
  });

  it("removes a trailing comma before a closing brace", () => {
    const input = '{"tasks":[1,2,]}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).tasks).toEqual([1, 2]);
  });

  it("handles a batch with nested task objects and an unescaped quote", () => {
    const input =
      '{"tasks":[{"type":"security","prompt":"audit "route.ts""}],"max_concurrency":"2"}';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
  });

  it("recovers from a markdown code fence", () => {
    const input = '```json\n{"tasks":[1,2]}\n```';
    const repaired = repairJsonText(input);
    expect(() => JSON.parse(repaired)).not.toThrow();
    expect(JSON.parse(repaired).tasks).toEqual([1, 2]);
  });
});

describe("repairToolCall", () => {
  it("returns null for already-valid input", async () => {
    const result = await repairToolCall({
      toolCall: {
        toolCallId: "1",
        toolName: "run_subagents",
        input: '{"tasks":[]}',
      },
    });
    expect(result).toBeNull();
  });

  it("repairs a malformed input string", async () => {
    const malformed =
      '{"tasks":[{"type":"security","prompt":"audit "route.ts" file"}]}';
    const result = await repairToolCall({
      toolCall: {
        toolCallId: "1",
        toolName: "run_subagents",
        input: malformed,
      },
    });
    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("run_subagents");
    // The SDK re-parses `input`, so it must be valid JSON text.
    if (!result) return;
    expect(() => JSON.parse(result.input)).not.toThrow();
  });

  it("returns null on an empty input", async () => {
    const result = await repairToolCall({
      toolCall: { toolCallId: "1", toolName: "run_subagents", input: "" },
    });
    expect(result).toBeNull();
  });

  it("falls back to the args field when input is absent", async () => {
    const result = await repairToolCall({
      toolCall: {
        toolCallId: "1",
        toolName: "run_subagents",
        args: '{"tasks":[]}',
      },
    });
    // Valid -> no repair -> null.
    expect(result).toBeNull();
  });

  it("rewrites a near-miss tool name to the real tool", async () => {
    const tools = {
      "ext_termigo-pentest-kit_run_pentest_tool": {},
      "ext_termigo-pentest-kit_recon": {},
      "ext_termigo-pentest-kit_scan": {},
    };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "1",
        toolName: "ext_termigo-pentest-kool_run_pentest_tool",
        input: '{"target":"example.test"}',
      },
    });
    expect(result?.toolName).toBe("ext_termigo-pentest-kit_run_pentest_tool");
    expect(result?.input).toBe('{"target":"example.test"}');
  });

  it("does not rewrite one real tool into a different one", async () => {
    const tools = {
      read_file: {},
      write_file: {},
      read_dir: {},
    };
    const result = await repairToolCall({
      tools,
      toolCall: { toolCallId: "1", toolName: "read_file", input: "{}" },
    });
    // `read_file` is a real tool, so this is not a NoSuchTool — no rewrite.
    expect(result).toBeNull();
  });

  it("returns null when the misspelled name has no close match", async () => {
    const tools = { run_subagents: {}, run_subagent: {} };
    const result = await repairToolCall({
      tools,
      toolCall: {
        toolCallId: "1",
        toolName: "totally_unrelated_tool",
        input: "{}",
      },
    });
    expect(result).toBeNull();
  });
});
