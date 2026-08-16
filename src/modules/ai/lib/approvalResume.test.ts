// Integration coverage for the seam that broke, three releases running.
//
// Every unit involved was correct on its own. `appendEnvTurn` appended a turn,
// `sanitizeUiMessages` closed out unfinished calls, `convertToModelMessages`
// converted. The failure lived between them: the env turn landed after an
// answered approval, and `streamText` looks for approvals in exactly one place.
//
//     // ai/dist - collect-tool-approvals.ts
//     const lastMessage = messages.at(-1);
//     if (lastMessage?.role != "tool") {
//       return { approvedToolApprovals: [], deniedToolApprovals: [] };
//     }
//
// So it found none, never ran the approved command, and sent the provider an
// assistant `tool_calls` with nothing answering it. Unit tests could not see
// this, because no unit was wrong.
//
// These run the real chain a request takes - `prepareOutgoingMessages`, then
// `sanitizeUiMessages`, then `convertToModelMessages` - and assert the two
// things the provider actually enforces.
import { describe, expect, it } from "vitest";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { prepareOutgoingMessages } from "./transport";
import { sanitizeUiMessages } from "./sanitizeMessages";

const ENV = "<env>\nworkspace_root: /w\n</env>";

const user = (id: string, text = "which openclaw"): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const assistant = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;

const call = (state: string, id: string, approval?: unknown) => ({
  type: "tool-bash_run",
  state,
  toolCallId: id,
  toolName: "bash_run",
  input: { command: "which openclaw" },
  ...(approval ? { approval } : {}),
});

/** The whole path a request takes, from stored history to model messages. */
async function outgoing(messages: UIMessage[]): Promise<ModelMessage[]> {
  return convertToModelMessages(
    sanitizeUiMessages(prepareOutgoingMessages(messages, ENV)),
  );
}

const partTypes = (m: ModelMessage): string[] =>
  Array.isArray(m.content)
    ? m.content.map((c) => (c as { type: string }).type)
    : ["text"];

/**
 * The rule every OpenAI-compatible provider enforces: an assistant `tool_calls`
 * must be answered. A tool-result answers it; so does an approval response,
 * because `streamText` executes that call before the provider ever sees it -
 * but only while the approval is still the last message.
 */
function unanswered(messages: ModelMessage[]): string[] {
  const parts = (m: ModelMessage) =>
    Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];

  const calls: string[] = [];
  const answered = new Set<string>();
  const callIdForApproval = new Map<string, string>();
  for (const m of messages) {
    for (const p of parts(m)) {
      if (p.type === "tool-call") calls.push(String(p.toolCallId));
      if (p.type === "tool-result") answered.add(String(p.toolCallId));
      if (p.type === "tool-approval-request") {
        callIdForApproval.set(String(p.approvalId), String(p.toolCallId));
      }
    }
  }

  // An approval only answers anything while the SDK can still see it, and the
  // SDK reads `messages.at(-1)` and gives up unless it is a tool message. An
  // approval buried behind a later turn is not an answer - it is the dangling
  // `tool_calls` the provider rejects. Mirroring that exactly is what makes
  // this check fail when something is appended after an approval.
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    for (const p of parts(last)) {
      if (p.type !== "tool-approval-response") continue;
      const id = callIdForApproval.get(String(p.approvalId));
      if (id) answered.add(id);
    }
  }
  return calls.filter((id) => !answered.has(id));
}

describe("an approved call still reaches streamText as an approval", () => {
  // The exact history from the bug report: user asks, the agent proposes a
  // command, the user approves, and the run is continued.
  const approved = [
    user("u1"),
    assistant("a1", [
      { type: "step-start" },
      call("approval-responded", "c1", { id: "ap1", approved: true }),
    ]),
  ];

  it("leaves the tool message last, which is the only place it is looked for", async () => {
    const out = await outgoing(approved);
    const last = out[out.length - 1];
    expect(last.role).toBe("tool");
    expect(partTypes(last)).toContain("tool-approval-response");
  });

  it("does not append the environment turn over it", async () => {
    const out = await outgoing(approved);
    expect(out.filter((m) => m.role === "user")).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("<env>");
  });

  it("keeps the approval answering its own call", async () => {
    const out = await outgoing(approved);
    expect(unanswered(out)).toEqual([]);
  });

  it("holds the env turn back for a denial too, which resumes the same way", async () => {
    const out = await outgoing([
      user("u1"),
      assistant("a1", [
        { type: "step-start" },
        call("approval-responded", "c1", { id: "ap1", approved: false }),
      ]),
    ]);
    expect(out[out.length - 1].role).toBe("tool");
  });

  it("does the same for several approvals answered in one step", async () => {
    const out = await outgoing([
      user("u1"),
      assistant("a1", [
        { type: "step-start" },
        call("approval-responded", "c1", { id: "ap1", approved: true }),
        call("approval-responded", "c2", { id: "ap2", approved: true }),
      ]),
    ]);
    expect(out[out.length - 1].role).toBe("tool");
    expect(unanswered(out)).toEqual([]);
  });
});

describe("everything else still gets the environment turn", () => {
  it("appends it to an ordinary user turn", async () => {
    const out = await outgoing([user("u1")]);
    expect(out[out.length - 1].role).toBe("user");
    expect(JSON.stringify(out)).toContain("<env>");
  });

  // A continuation after tools ran already ends in a tool message full of
  // results, so a trailing user turn costs nothing there.
  it("appends it after a step whose tools have produced results", async () => {
    const out = await outgoing([
      user("u1"),
      assistant("a1", [
        { type: "step-start" },
        { ...call("output-available", "c1"), output: { stdout: "/usr/bin" } },
      ]),
    ]);
    expect(out[out.length - 1].role).toBe("user");
    expect(unanswered(out)).toEqual([]);
  });

  it("appends it once the conversation has moved past an approval", async () => {
    const out = await outgoing([
      user("u1"),
      assistant("a1", [
        { type: "step-start" },
        call("approval-responded", "c1", { id: "ap1", approved: true }),
      ]),
      user("u2", "actually, never mind"),
    ]);
    expect(out[out.length - 1].role).toBe("user");
    expect(JSON.stringify(out)).toContain("<env>");
  });
});

// Whatever the run was doing when it stopped, the history it sends next has to
// be one a provider will accept. These are the states a stopped run leaves
// behind, each carried the whole way to model messages.
describe("no history leaves a tool call unanswered", () => {
  const cases: Array<[string, UIMessage[]]> = [
    [
      "a call interrupted before it ran",
      [user("u1"), assistant("a1", [call("input-available", "c1")]), user("u2")],
    ],
    [
      "an approval nobody answered",
      [
        user("u1"),
        assistant("a1", [call("approval-requested", "c1", { id: "ap1" })]),
        user("u2"),
      ],
    ],
    [
      "an approved call the run never executed, then a new message",
      [
        user("u1"),
        assistant("a1", [call("approval-responded", "c1", { id: "ap1", approved: true })]),
        user("u2"),
      ],
    ],
    [
      "a session restored mid-stream, arguments half written",
      [user("u1"), assistant("a1", [call("input-streaming", "c1")]), user("u2")],
    ],
    [
      "several steps, only the last one live",
      [
        user("u1"),
        assistant("a1", [
          { type: "step-start" },
          { ...call("output-available", "c1"), output: { ok: true } },
          { type: "step-start" },
          call("input-available", "c2"),
        ]),
        user("u2"),
      ],
    ],
  ];

  for (const [name, history] of cases) {
    it(name, async () => {
      expect(unanswered(await outgoing(history))).toEqual([]);
    });
  }
});
