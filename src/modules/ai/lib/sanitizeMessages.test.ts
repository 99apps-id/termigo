import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { sanitizeUiMessages } from "./sanitizeMessages";

function assistantMessage(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts: parts as UIMessage["parts"] };
}

function userMessage(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: "hello" }] };
}

// Matches what the SDK actually puts in a message: the part is named after
// the tool. The previous helper used a "tool-invocation" type that the app
// never produces, so these tests passed against a filter that matched nothing.
function toolPart(state: string, toolCallId: string, toolName = "bash_run") {
  return {
    type: `tool-${toolName}`,
    state,
    toolCallId,
    toolName,
    input: { command: "echo hi" },
  };
}

describe("sanitizeUiMessages", () => {
  it("drops a call stuck awaiting execution (never produced a result)", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [toolPart("input-available", "call_1")]),
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

describe("sanitizeUiMessages: resumed sessions", () => {
  // Continuing a session that was interrupted mid-call used to fail with
  // "An assistant message with 'tool_calls' must be followed by tool messages
  // responding to each 'tool_call_id'", because the filter matched a part type
  // the app never emits and so removed nothing.
  it("removes a call the app was still executing when it stopped", () => {
    const out = sanitizeUiMessages([
      userMessage("u1"),
      assistantMessage("a1", [
        { type: "text", text: "Let me check the server." },
        toolPart("input-available", "call_ssh", "bash_run"),
      ]),
      userMessage("u2"),
    ]);
    const assistant = out[1].parts as Array<{ type: string }>;
    expect(assistant).toHaveLength(1);
    expect(assistant[0].type).toBe("text");
  });

  it("removes dynamic (MCP) calls too, which are not named tool-<name>", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [
        { type: "dynamic-tool", state: "input-available", toolCallId: "c1" },
      ]),
    ]);
    expect(out).toHaveLength(0);
  });

  it("keeps a completed call so the model still sees its result", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [
        { ...toolPart("output-available", "c1"), output: { stdout: "ok" } },
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0].parts as Array<{ state?: string }>)[0].state).toBe(
      "output-available",
    );
  });

  it("keeps a failed call, which is a real result the model can react to", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [toolPart("output-error", "c1")]),
    ]);
    expect(out).toHaveLength(1);
  });
});
