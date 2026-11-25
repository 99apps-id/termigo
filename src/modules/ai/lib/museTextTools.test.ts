import { describe, expect, it } from "vitest";
import { chatToResponsesBody, responsesStreamToChatSse } from "./museTextTools";

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
