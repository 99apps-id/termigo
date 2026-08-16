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

type P = { type: string; state?: string; errorText?: string };
const partsOf = (m: UIMessage) => m.parts as unknown as P[];

/** Every state a provider accepts as answering a tool_call. */
const RESOLVED = new Set([
  "output-available",
  "output-error",
  "output-denied",
  "result",
]);

describe("sanitizeUiMessages", () => {
  it("closes out a call stuck awaiting execution instead of deleting it", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [toolPart("input-available", "call_1")]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(2);
    const tool = partsOf(out[1])[0];
    expect(tool.state).toBe("output-error");
    expect(tool.errorText).toMatch(/interrupted/i);
  });

  it("closes out a call stuck in approval-requested (abandoned approval)", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [
        toolPart("approval-requested", "call_1"),
        { type: "text", text: "waiting…" },
      ]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(2);
    const parts = partsOf(out[1]);
    expect(parts).toHaveLength(2);
    expect(parts[0].state).toBe("output-error");
    expect(parts[1].type).toBe("text");
  });

  it("keeps approval-responded while the run is being continued", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [
        toolPart("approval-responded", "call_1"),
        { type: "text", text: "decided" },
      ]),
    ];
    const out = sanitizeUiMessages(messages);
    expect(out).toHaveLength(2);
    const tool = partsOf(out[1]).find((p) => p.state === "approval-responded");
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
    const second = partsOf(out[1]);
    expect(second).toHaveLength(2);
    expect(second[0].state).toBe("output-error");
    expect(second[1].state).toBe("output-available");
  });
});

describe("sanitizeUiMessages: resumed sessions", () => {
  // Continuing a session that was interrupted mid-call used to fail with
  // "An assistant message with 'tool_calls' must be followed by tool messages
  // responding to each 'tool_call_id'".
  it("closes out a call the app was still executing when it stopped", () => {
    const out = sanitizeUiMessages([
      userMessage("u1"),
      assistantMessage("a1", [
        { type: "text", text: "Let me check the server." },
        toolPart("input-available", "call_ssh", "bash_run"),
      ]),
      userMessage("u2"),
    ]);
    const parts = partsOf(out[1]);
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("text");
    expect(parts[1].state).toBe("output-error");
  });

  // The bug this rewrite exists for: an approval the user answered, whose call
  // never ran because the run stopped. It survived the old filter untouched
  // and poisoned the session - every later message failed on the same history.
  it("closes out an approved call once the conversation has moved on", () => {
    const out = sanitizeUiMessages([
      userMessage("u1"),
      assistantMessage("a1", [toolPart("approval-responded", "call_1")]),
      userMessage("u2"),
    ]);
    const tool = partsOf(out[1])[0];
    expect(tool.state).toBe("output-error");
    expect(tool.errorText).toMatch(/interrupted/i);
  });

  it("closes out an approved call left in an earlier turn of a continued run", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [toolPart("approval-responded", "stale")]),
      userMessage("u1"),
      assistantMessage("a2", [toolPart("approval-responded", "live")]),
    ]);
    expect(partsOf(out[0])[0].state).toBe("output-error");
    expect(partsOf(out[2])[0].state).toBe("approval-responded");
  });

  it("drops a call whose arguments were still streaming", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [
        { type: "text", text: "thinking" },
        toolPart("input-streaming", "half"),
      ]),
    ]);
    expect(partsOf(out[0])).toHaveLength(1);
    expect(partsOf(out[0])[0].type).toBe("text");
  });

  it("closes out dynamic (MCP) calls too, which are not named tool-<name>", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [
        { type: "dynamic-tool", state: "input-available", toolCallId: "c1" },
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(partsOf(out[0])[0].state).toBe("output-error");
  });

  it("keeps a completed call so the model still sees its result", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [
        { ...toolPart("output-available", "c1"), output: { stdout: "ok" } },
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(partsOf(out[0])[0].state).toBe("output-available");
  });

  it("keeps a failed call, which is a real result the model can react to", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [toolPart("output-error", "c1")]),
    ]);
    expect(out).toHaveLength(1);
  });

  // The invariant the provider actually enforces: nothing unresolved survives,
  // except the live approval the SDK is about to execute.
  it("leaves no unresolved tool call in a history that ends on a user turn", () => {
    const out = sanitizeUiMessages([
      userMessage("u1"),
      assistantMessage("a1", [
        toolPart("input-available", "c1"),
        toolPart("approval-requested", "c2"),
        toolPart("approval-responded", "c3"),
        { ...toolPart("output-available", "c4"), output: { ok: true } },
      ]),
      userMessage("u2"),
    ]);
    for (const message of out) {
      for (const part of partsOf(message)) {
        if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool")
          continue;
        expect(RESOLVED.has(part.state ?? "")).toBe(true);
      }
    }
  });
});

// The bug this guards: the env block is appended as a user turn on every
// request, so "is the last message an assistant turn" answered no every single
// time. An approved call was never recognised as live, every one was reported
// to the model as interrupted, and the model tried again - a loop that left 56
// calls stranded in `approval-responded`, 37 of them bash_run.
describe("sanitizeUiMessages: the trailing env turn", () => {
  const ENV = "<env>\nworkspace_root: C:/project/termigo\n</env>";
  const envTurn = () =>
    ({ id: "env", role: "user", parts: [{ type: "text", text: ENV }] }) as UIMessage;

  it("still recognises a live approval behind the env turn", () => {
    const out = sanitizeUiMessages([
      userMessage("u1"),
      assistantMessage("a1", [toolPart("approval-responded", "call_1")]),
      envTurn(),
    ]);
    const tool = (out[1].parts as Array<{ state?: string }>)[0];
    expect(tool.state).toBe("approval-responded");
  });

  it("still closes out an approval the conversation has moved past", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [toolPart("approval-responded", "stale")]),
      userMessage("u2"),
      envTurn(),
    ]);
    expect((out[0].parts as Array<{ state?: string }>)[0].state).toBe(
      "output-error",
    );
  });

  it("does not treat a real request as an env turn", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [toolPart("approval-responded", "stale")]),
      userMessage("u2"),
    ]);
    expect((out[0].parts as Array<{ state?: string }>)[0].state).toBe(
      "output-error",
    );
  });
});

// `convertToModelMessages` emits a `tool-approval-request` for any part still
// carrying an `approval`, and answers it only when `approval.approved` is set.
// A call interrupted while waiting for an answer therefore produced a request
// with no response, and the provider rejected the whole message with
// "insufficient tool messages following tool_calls".
describe("sanitizeUiMessages: the approval field", () => {
  const withApproval = (state: string, id: string, approval: unknown) => ({
    type: "tool-bash_run",
    state,
    toolCallId: id,
    toolName: "bash_run",
    input: { command: "which openclaw" },
    approval,
  });

  it("drops a half-open approval when closing a call out", () => {
    const out = sanitizeUiMessages([
      userMessage("u1"),
      assistantMessage("a1", [
        withApproval("approval-requested", "c1", { id: "ap1" }),
      ]),
      userMessage("u2"),
    ]);
    const tool = (out[1].parts as Array<Record<string, unknown>>)[0];
    expect(tool.state).toBe("output-error");
    expect("approval" in tool).toBe(false);
  });

  it("drops it for an approved-but-never-run call too", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [
        withApproval("approval-responded", "c1", { id: "ap1", approved: true }),
      ]),
      userMessage("u2"),
    ]);
    const tool = (out[0].parts as Array<Record<string, unknown>>)[0];
    expect(tool.state).toBe("output-error");
    expect("approval" in tool).toBe(false);
  });

  // A live approval is left completely alone: the SDK is about to execute it,
  // and the approval conversation is what makes that work.
  it("leaves a live approval and its field untouched", () => {
    const out = sanitizeUiMessages([
      userMessage("u1"),
      assistantMessage("a1", [
        withApproval("approval-responded", "c1", { id: "ap1", approved: true }),
      ]),
    ]);
    const tool = (out[1].parts as Array<Record<string, unknown>>)[0];
    expect(tool.state).toBe("approval-responded");
    expect(tool.approval).toEqual({ id: "ap1", approved: true });
  });

  it("keeps everything else the call carried", () => {
    const out = sanitizeUiMessages([
      assistantMessage("a1", [
        withApproval("approval-requested", "c1", { id: "ap1" }),
      ]),
      userMessage("u2"),
    ]);
    const tool = (out[0].parts as Array<Record<string, unknown>>)[0];
    expect(tool.toolCallId).toBe("c1");
    expect(tool.input).toEqual({ command: "which openclaw" });
  });
});
