import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { sanitizeUiMessages } from "./sanitizeMessages";

function assistantMessage(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts: parts as UIMessage["parts"] };
}

function userMessage(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: "hello" }] };
}

function toolPart(state: string, toolCallId: string, toolName = "bash_run") {
  return {
    type: "tool-invocation",
    state,
    toolCallId,
    toolName,
    input: { command: "echo hi" },
  };
}

describe("sanitizeUiMessages", () => {
  it("drops tool invocations stuck in the input state (never produced a result)", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [toolPart("input", "call_1")]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(1); // the assistant turn is removed entirely
    expect(out[0].id).toBe("u1");
  });

  it("drops tool invocations stuck in approval-requested (abandoned approval)", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [
        toolPart("approval-requested", "call_1"),
        { type: "text", text: "waiting…" },
      ]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(2);
    const parts = out[1].parts as Array<{ type: string; state?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
  });

  it("keeps approval-responded parts (the user's approve/deny decision)", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [
        toolPart("approval-responded", "call_1"),
        { type: "text", text: "decided" },
      ]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(2);
    const parts = out[1].parts as Array<{ state?: string }>;
    const tool = parts.find((p) => p.state === "approval-responded");
    expect(tool).toBeDefined();
  });

  it("keeps result and output-available parts", () => {
    const messages = [
      assistantMessage("a1", [
        { ...toolPart("output-available", "call_1"), output: { ok: true } },
        { ...toolPart("result", "call_2"), result: { ok: true } },
      ]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].parts).toHaveLength(2);
  });

  it("keeps non-assistant messages untouched", () => {
    const messages = [userMessage("u1"), userMessage("u2")];
    expect(sanitizeUiMessages(messages)).toHaveLength(2);
  });

  it("keeps text-only and mixed assistant turns", () => {
    const messages = [
      assistantMessage("a1", [{ type: "text", text: "plain answer" }]),
      assistantMessage("a2", [
        toolPart("approval-requested", "call_1"),
        toolPart("output-available", "call_2"),
      ]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(2);
    const second = out[1].parts as Array<{ state?: string }>;
    expect(second).toHaveLength(1);
    expect(second[0].state).toBe("output-available");
  });
});
