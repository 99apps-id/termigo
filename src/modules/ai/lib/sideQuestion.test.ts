import { describe, expect, it } from "vitest";
import { renderTranscript, type SideQuestionMessage } from "./sideQuestion";

function user(text: string): SideQuestionMessage {
  return { role: "user", parts: [{ type: "text", text }] };
}

function assistant(text: string): SideQuestionMessage {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

function toolCall(
  toolName: string,
  output?: unknown,
  state: string = output !== undefined ? "output-available" : "input-available",
): SideQuestionMessage {
  return {
    role: "assistant",
    parts: [{ type: `tool-${toolName}`, toolName, state, output }],
  };
}

describe("renderTranscript", () => {
  it("returns a placeholder for an empty transcript", () => {
    expect(renderTranscript([])).toBe("(no prior conversation)");
  });

  it("renders user and assistant text with role labels", () => {
    const out = renderTranscript([user("hello"), assistant("hi there")]);
    expect(out).toBe("USER: hello\nASSISTANT: hi there");
  });

  it("skips system messages", () => {
    const out = renderTranscript([
      { role: "system", parts: [{ type: "text", text: "secret prompt" }] },
      user("hello"),
    ]);
    expect(out).toBe("USER: hello");
    expect(out).not.toContain("secret prompt");
  });

  it("summarises tool calls by name", () => {
    const out = renderTranscript([toolCall("read_file")]);
    expect(out).toBe("ASSISTANT [called tools: read_file]");
  });

  it("groups multiple tool calls of one message into a single line", () => {
    const msg: SideQuestionMessage = {
      role: "assistant",
      parts: [
        { type: "tool-read_file", toolName: "read_file", state: "input-available" },
        { type: "tool-grep", toolName: "grep", state: "input-available" },
      ],
    };
    expect(renderTranscript([msg])).toBe(
      "ASSISTANT [called tools: read_file, grep]",
    );
  });

  it("includes available tool output as a TOOL RESULT line", () => {
    const out = renderTranscript([toolCall("bash_run", "exit 0")]);
    expect(out).toBe(
      "ASSISTANT [called tools: bash_run]\nTOOL RESULT: bash_run: exit 0",
    );
  });

  it("stringifies non-string tool output", () => {
    const out = renderTranscript([toolCall("edit", { ok: true, path: "a.ts" })]);
    expect(out).toContain('TOOL RESULT: edit: {"ok":true,"path":"a.ts"}');
  });

  it("omits output for calls that have not resolved", () => {
    const out = renderTranscript([
      {
        role: "assistant",
        parts: [
          {
            type: "tool-write_file",
            toolName: "write_file",
            state: "input-available",
            output: undefined,
          },
        ],
      },
    ]);
    expect(out).toBe("ASSISTANT [called tools: write_file]");
    expect(out).not.toContain("TOOL RESULT");
  });

  it("caps each message at 2000 characters", () => {
    const out = renderTranscript([user("x".repeat(5000))]);
    expect(out).toBe(`USER: ${"x".repeat(2000)}`);
  });

  it("caps each tool result at 2000 characters", () => {
    const out = renderTranscript([toolCall("read_file", "y".repeat(5000))]);
    const resultLine = out.split("\n").find((l) => l.startsWith("TOOL RESULT"));
    // The cap applies to the combined "name: output" string (2000 chars),
    // then the "TOOL RESULT: " prefix is added.
    expect(resultLine?.length).toBe("TOOL RESULT: ".length + 2000);
    expect(resultLine?.endsWith("y")).toBe(true);
  });

  it("fits newest-biased within the char budget and marks the omission", () => {
    const msgs: SideQuestionMessage[] = [];
    for (let i = 0; i < 10; i++) msgs.push(user(`message number ${i}`));
    // Budget fits roughly the last two lines only.
    const out = renderTranscript(msgs, 45);
    expect(out.startsWith("[...older conversation omitted...]")).toBe(true);
    expect(out).toContain("message number 9");
    expect(out).not.toContain("message number 0");
  });

  it("keeps at least the newest line even when it alone exceeds the budget", () => {
    const out = renderTranscript([user("a".repeat(100)), user("tail")], 10);
    expect(out).toContain("tail");
  });

  it("does not add the omission prefix when everything fits", () => {
    const out = renderTranscript([user("a"), assistant("b")], 1000);
    expect(out).not.toContain("omitted");
    expect(out).toBe("USER: a\nASSISTANT: b");
  });

  it("joins multiple text parts of one message", () => {
    const msg: SideQuestionMessage = {
      role: "assistant",
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(renderTranscript([msg])).toBe("ASSISTANT: first\nsecond");
  });

  it("ignores messages without parts and non-text junk parts", () => {
    const out = renderTranscript([
      { role: "user" },
      { role: "user", parts: [{ type: "file", text: 42 }, null as never] },
      user("kept"),
    ]);
    expect(out).toBe("USER: kept");
  });

  it("treats dynamic-tool parts like tool calls", () => {
    const msg: SideQuestionMessage = {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "mcp_thing",
          state: "output-available",
          output: "done",
        },
      ],
    };
    expect(renderTranscript([msg])).toBe(
      "ASSISTANT [called tools: mcp_thing]\nTOOL RESULT: mcp_thing: done",
    );
  });
});
