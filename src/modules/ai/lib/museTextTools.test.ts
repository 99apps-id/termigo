import { describe, expect, it } from "vitest";
import {
  chatToResponsesBody,
  parseTextToolCalls,
  responsesStreamToChatSse,
} from "./museTextTools";

const baseBody = {
  model: "muse-spark-1.3",
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Fix the bug." },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    },
  ],
};

describe("chatToResponsesBody tool_choice", () => {
  it("teaches the text tool protocol when tools are available", () => {
    const out = chatToResponsesBody(baseBody);
    expect(out).not.toBeNull();
    expect(out?.instructions).toContain("Tool use (text protocol)");
    expect(out?.instructions).not.toContain("Tool use is disabled");
  });

  it("tells the model tools are off when tool_choice is none", () => {
    // The agent loop's forced synthesis step arrives as tool_choice "none".
    // The Responses route has no tools field to switch off, so the
    // instruction text is the only channel: without it the model emits
    // tool_call blocks anyway and the loop marks it as ignoring the forced
    // choice.
    const out = chatToResponsesBody({ ...baseBody, tool_choice: "none" });
    expect(out).not.toBeNull();
    expect(out?.instructions).toContain("Tool use is disabled for this reply");
    expect(out?.instructions).not.toContain("Tool use (text protocol)");
  });

  it("accepts the object form of tool_choice none", () => {
    const out = chatToResponsesBody({
      ...baseBody,
      tool_choice: { type: "none" },
    });
    expect(out?.instructions).toContain("Tool use is disabled for this reply");
  });
});

describe("parseTextToolCalls tolerance", () => {
  it("keeps valid calls and leaves a bad block as prose", () => {
    const text =
      "Before.\n" +
      '```tool_call\n{"name":"bash_run","arguments":{"command":"ls"}}\n```\n' +
      "Middle.\n```tool_call\n{not json}\n```\nAfter.";
    const { prose, calls } = parseTextToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("bash_run");
    expect(calls[0]?.arguments).toBe('{"command":"ls"}');
    expect(prose).toContain("Before.");
    expect(prose).toContain("{not json}");
    expect(prose).toContain("After.");
  });

  it("accepts the XML tag and json fence spellings", () => {
    const xml = parseTextToolCalls(
      '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>',
    );
    expect(xml.calls).toHaveLength(1);
    expect(xml.calls[0]?.name).toBe("read_file");
    const fenced = parseTextToolCalls(
      '```json\n{"name":"grep","arguments":{}}\n```',
    );
    expect(fenced.calls).toHaveLength(1);
    expect(fenced.calls[0]?.name).toBe("grep");
  });

  it("survives an unclosed trailing block", () => {
    const text =
      '```tool_call\n{"name":"bash_run","arguments":{}}\n```\n' +
      '```tool_call\n{"name":"x"';
    const { prose, calls } = parseTextToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(prose).toContain('{"name":"x"');
  });

  it("returns the text untouched when no block is a valid call", () => {
    const text = "```tool_call\n{bad}\n```";
    const { prose, calls } = parseTextToolCalls(text);
    expect(calls).toHaveLength(0);
    expect(prose).toBe(text);
  });
});

describe("chatToResponsesBody tool results", () => {
  it("carries the tool name in the tool_result block", () => {
    const out = chatToResponsesBody({
      model: "muse-spark-1.3",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "bash_run",
                arguments: '{"command":"ls"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file.txt" },
      ],
    });
    const input = (out as { input?: unknown[] } | null)?.input ?? [];
    const resultItem = input.find((item) =>
      JSON.stringify(item).includes("tool_result"),
    );
    expect(resultItem).toBeDefined();
    const text = (resultItem as { content: { text: string }[] }).content[0]
      ?.text;
    const block = JSON.parse(
      String(text)
        .replace(/```tool_result\n?/, "")
        .replace(/\n?```$/, ""),
    ) as Record<string, unknown>;
    expect(block.name).toBe("bash_run");
    expect(block.call_id).toBe("call_1");
    expect(block.output).toBe("file.txt");
  });
});

describe("responsesStreamToChatSse incomplete handling", () => {
  const sse = (events: unknown[]) =>
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const delta = { type: "response.output_text.delta", delta: "partial ans" };
  const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };

  it("ends a completed reply as stop", () => {
    const out = responsesStreamToChatSse(
      sse([delta, { type: "response.completed", response: { usage } }]),
      "muse-spark-1.3",
    );
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain("partial ans");
  });

  it("ends a reply cut at the output limit as length, not stop", () => {
    const out = responsesStreamToChatSse(
      sse([
        delta,
        {
          type: "response.incomplete",
          response: {
            usage,
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      "muse-spark-1.3",
    );
    expect(out).toContain('"finish_reason":"length"');
    expect(out).not.toContain('"finish_reason":"stop"');
    expect(out).toContain("partial ans");
  });

  it("surfaces a non-limit incomplete as an error naming the reason", () => {
    const out = responsesStreamToChatSse(
      sse([
        delta,
        {
          type: "response.incomplete",
          response: {
            usage,
            incomplete_details: { reason: "content_filter" },
          },
        },
      ]),
      "muse-spark-1.3",
    );
    expect(out).toContain("muse_response_incomplete");
    expect(out).toContain("content_filter");
  });
});
