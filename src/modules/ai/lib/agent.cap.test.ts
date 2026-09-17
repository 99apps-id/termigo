import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { capHistoryMessageCount } from "./agent";
import { repairModelMessageSequence } from "./validateModelSequence";

function makeMessage(role: string, index: number): ModelMessage {
  if (role === "user") {
    return { role: "user", content: `user request ${index}` };
  }
  if (role === "assistant") {
    return {
      role: "assistant",
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `call_${index}`,
          toolName: "read_file",
          input: { path: `src/f${index}.ts` },
        },
      ],
    };
  }
  return {
    role: "tool",
    content: [
      {
        type: "tool-result" as const,
        toolCallId: `call_${index - 1}`,
        toolName: "read_file",
        output: { content: `file ${index - 1}` },
      },
    ],
  };
}

describe("runAgentStream message-count cap", () => {
  it("does not trim when history is under the limit", () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", i),
    );

    const result = capHistoryMessageCount(messages);
    expect(result.capped).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.messages.length).toBe(100);
  });

  it("trims cleanly and never starts kept history on a tool message", () => {
    // Build 508 messages matching the field scenario where excess is 8
    // Pattern: User, Assistant (call), Tool (result), Assistant (call), Tool (result)...
    const messages: ModelMessage[] = [];
    let idx = 0;
    while (messages.length < 508) {
      messages.push({ role: "user", content: `prompt ${idx}` });
      if (messages.length >= 508) break;
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: `c_${idx}`,
            toolName: "read_file",
            input: { path: `f${idx}.ts` },
          },
        ],
      });
      if (messages.length >= 508) break;
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `c_${idx}`,
            toolName: "read_file",
            output: "ok",
          },
        ],
      });
      idx++;
    }

    const capped = capHistoryMessageCount(messages, 500, 50);
    expect(capped.capped).toBe(true);
    expect(capped.messages.length).toBeLessThanOrEqual(500);
    // Crucial check: kept history must NEVER start with a tool message
    expect(capped.messages[0].role).not.toBe("tool");
    expect(capped.messages[0].role).toBe("user");

    // Sequence repair pass preserves valid provider invariants
    const repaired = repairModelMessageSequence(capped.messages);
    expect(repaired[0].role).toBe("user");
    expect(repaired.length).toBeGreaterThan(0);
  });

  it("never drops the tail even when the history is huge", () => {
    const limit = 500;
    const tailKeep = 50;
    const total = 1000;

    const messages = Array.from({ length: total }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", i),
    );

    const result = capHistoryMessageCount(messages, limit, tailKeep);
    expect(result.capped).toBe(true);
    expect(result.messages.length).toBeLessThanOrEqual(limit);
    // Verify tail preserved
    expect(result.messages[result.messages.length - 1]).toBe(
      messages[messages.length - 1],
    );
  });
});
