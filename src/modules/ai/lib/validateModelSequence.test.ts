import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { repairModelMessageSequence } from "./validateModelSequence";

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantTextMsg(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

function assistantToolCallsMsg(
  calls: Array<{ id: string; name: string }>,
): ModelMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "tool-call" as const,
      toolCallId: c.id,
      toolName: c.name,
      input: {},
    })),
  };
}

function toolResultMsg(
  results: Array<{ id: string; name?: string; value?: unknown }>,
): ModelMessage {
  return {
    role: "tool",
    content: results.map((r) => ({
      type: "tool-result" as const,
      toolCallId: r.id,
      toolName: r.name ?? "test_tool",
      output: r.value ?? { success: true },
    })),
  };
}

describe("repairModelMessageSequence", () => {
  it("returns empty array for empty input", () => {
    expect(repairModelMessageSequence([])).toEqual([]);
  });

  it("preserves standard user-assistant conversation", () => {
    const input: ModelMessage[] = [
      userMsg("hello"),
      assistantTextMsg("hi there"),
      userMsg("how are you?"),
      assistantTextMsg("doing well"),
    ];
    const res = repairModelMessageSequence(input);
    expect(res).toEqual(input);
  });

  it("preserves properly paired assistant tool-call and tool-result turns", () => {
    const input: ModelMessage[] = [
      userMsg("check file"),
      assistantToolCallsMsg([{ id: "call_1", name: "read_file" }]),
      toolResultMsg([{ id: "call_1", name: "read_file", value: "content" }]),
      assistantTextMsg("file content is read"),
    ];
    const res = repairModelMessageSequence(input);
    expect(res).toEqual(input);
  });

  it("drops orphaned tool message at the start of the sequence", () => {
    // Exactly the bug that triggered 400 Bad Request on OpenAI
    const input: ModelMessage[] = [
      toolResultMsg([{ id: "call_old", name: "read_file" }]),
      userMsg("what is next?"),
      assistantTextMsg("all good"),
    ];
    const res = repairModelMessageSequence(input);
    expect(res).toHaveLength(2);
    expect(res[0].role).toBe("user");
    expect(res[0].content).toBe("what is next?");
    expect(res[1].role).toBe("assistant");
  });

  it("drops multiple orphaned tool messages at the start of sequence", () => {
    const input: ModelMessage[] = [
      toolResultMsg([{ id: "call_old_1" }]),
      toolResultMsg([{ id: "call_old_2" }]),
      userMsg("hello"),
    ];
    const res = repairModelMessageSequence(input);
    expect(res).toHaveLength(1);
    expect(res[0].role).toBe("user");
  });

  it("drops orphaned tool message in the middle of conversation", () => {
    const input: ModelMessage[] = [
      userMsg("do step 1"),
      assistantTextMsg("done step 1"),
      toolResultMsg([{ id: "unmatched_call_id" }]),
      userMsg("do step 2"),
    ];
    const res = repairModelMessageSequence(input);
    expect(res).toHaveLength(3);
    expect(res.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("filters out mismatched tool results when partial match exists", () => {
    const input: ModelMessage[] = [
      userMsg("fetch"),
      assistantToolCallsMsg([{ id: "call_valid", name: "get_data" }]),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_valid",
            toolName: "get_data",
            output: "ok",
          },
          {
            type: "tool-result",
            toolCallId: "call_invalid",
            toolName: "stale_tool",
            output: "stale",
          },
        ],
      } as ModelMessage,
    ];
    const res = repairModelMessageSequence(input);
    expect(res).toHaveLength(3);
    const toolMsg = res[2];
    expect(Array.isArray(toolMsg.content)).toBe(true);
    expect((toolMsg.content as unknown[]).length).toBe(1);
  });

  it("synthesizes missing tool results if an assistant call was interrupted before next user turn", () => {
    const input: ModelMessage[] = [
      userMsg("run two tools"),
      assistantToolCallsMsg([
        { id: "call_1", name: "tool1" },
        { id: "call_2", name: "tool2" },
      ]),
      toolResultMsg([{ id: "call_1", name: "tool1" }]),
      // call_2 is missing before user interrupts
      userMsg("stop and do this instead"),
    ];
    const res = repairModelMessageSequence(input);
    // Should have: user, assistant, tool1, synthetic tool2, user
    expect(res).toHaveLength(5);
    expect(res[0].role).toBe("user");
    expect(res[1].role).toBe("assistant");
    expect(res[2].role).toBe("tool");
    expect(res[3].role).toBe("tool");
    const syntheticTool = res[3];
    expect(
      (syntheticTool.content as Array<{ toolCallId: string }>)[0].toolCallId,
    ).toBe("call_2");
    expect(res[4].role).toBe("user");
  });

  it("synthesizes missing tool results if sequence ends with unanswered tool calls", () => {
    const input: ModelMessage[] = [
      userMsg("run a tool"),
      assistantToolCallsMsg([{ id: "call_end", name: "slow_tool" }]),
    ];
    const res = repairModelMessageSequence(input);
    expect(res).toHaveLength(3);
    expect(res[0].role).toBe("user");
    expect(res[1].role).toBe("assistant");
    expect(res[2].role).toBe("tool");
    expect(
      (res[2].content as Array<{ toolCallId: string }>)[0].toolCallId,
    ).toBe("call_end");
  });

  it("prepends synthetic user message if conversation starts with assistant message", () => {
    const input: ModelMessage[] = [
      assistantTextMsg("Here is the previous answer"),
      userMsg("thanks"),
    ];
    const res = repairModelMessageSequence(input);
    expect(res[0].role).toBe("user");
    expect(res[0].content).toBe("[Continuing previous task]");
    expect(res[1]).toEqual(input[0]);
    expect(res[2]).toEqual(input[1]);
  });

  it("prepends synthetic user message before assistant with tool-calls when history starts at assistant", () => {
    const input: ModelMessage[] = [
      assistantToolCallsMsg([{ id: "call_1", name: "read_file" }]),
      toolResultMsg([{ id: "call_1", name: "read_file" }]),
    ];
    const res = repairModelMessageSequence(input);
    expect(res[0].role).toBe("user");
    expect(res[1].role).toBe("assistant");
    expect(res[2].role).toBe("tool");
  });
});
