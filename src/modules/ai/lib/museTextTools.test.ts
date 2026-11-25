import { describe, expect, it } from "vitest";
import { chatToResponsesBody } from "./museTextTools";

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
