import { describe, expect, it, vi } from "vitest";
import {
  isUnfinishedOrGarbledSummary,
  safeJson,
  sanitizeGarbledSummary,
  synthesizeSummary,
} from "./subagentSummary";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

describe("safeJson", () => {
  it("returns strings directly", () => {
    expect(safeJson("hello")).toBe("hello");
  });

  it("serializes objects", () => {
    expect(safeJson({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("handles circular references gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJson(circular)).toBe("[object Object]");
  });
});

describe("synthesizeSummary", () => {
  it("returns empty string when no steps or tool results exist", async () => {
    const { generateText } = await import("ai");
    const result = {
      steps: [],
      text: "",
    } as unknown as Parameters<typeof synthesizeSummary>[3];

    const res = await synthesizeSummary(
      {} as never,
      "system",
      "prompt",
      result,
      new AbortController().signal,
    );

    expect(res).toBe("");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("extracts findings and generates summary", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValue({
      text: "Synthesized summary.",
    } as never);

    const result = {
      steps: [
        {
          text: "Step 1 text",
          toolResults: [
            {
              toolName: "grep",
              input: { query: "foo" },
              output: "matched 3 lines",
            },
          ],
        },
      ],
      text: "",
    } as unknown as Parameters<typeof synthesizeSummary>[3];

    const res = await synthesizeSummary(
      {} as never,
      "system prompt",
      "original prompt",
      result,
      new AbortController().signal,
    );

    expect(res).toBe("Synthesized summary.");
    expect(generateText).toHaveBeenCalled();
  });
});

describe("isUnfinishedOrGarbledSummary", () => {
  it("flags empty or whitespace-only summary", () => {
    expect(isUnfinishedOrGarbledSummary("", { steps: [] }, 6)).toBe(true);
    expect(isUnfinishedOrGarbledSummary("   ", { steps: [] }, 6)).toBe(true);
  });

  it("flags incomplete sentences ending with a colon after hitting step limit or tool call", () => {
    const result = {
      steps: [
        { toolCalls: [{ toolName: "read_file" }] },
      ],
    };
    expect(
      isUnfinishedOrGarbledSummary(
        "Let me check the Tauri command module registration and the project.rs:",
        result,
        1,
      ),
    ).toBe(true);
  });

  it("flags raw hallucinated pseudo tool tags", () => {
    const result = { steps: [{ toolCalls: [] }] };
    expect(
      isUnfinishedOrGarbledSummary(
        "<tool_call><function=read_file><args>...</args></function></tool_call>",
        result,
        6,
      ),
    ).toBe(true);
    expect(
      isUnfinishedOrGarbledSummary(
        "read_file({\"path\":\"foo.rs\"}) -> { ... }",
        result,
        6,
      ),
    ).toBe(true);
  });

  it("accepts a normal finished prose summary", () => {
    const result = {
      steps: [
        { toolCalls: [{ toolName: "read_file" }] },
        { toolCalls: [] },
      ],
    };
    const goodSummary =
      "Audit findings: 1. In downloader.rs: missing validation for protocol schemes. 2. In video.rs: unchecked integer conversion. Everything else looks fine.";
    expect(isUnfinishedOrGarbledSummary(goodSummary, result, 6)).toBe(false);
  });
});

describe("sanitizeGarbledSummary", () => {
  it("strips pseudo tool tags from text", () => {
    const raw = "Leading text <tool_call><function=read_file>content</function></tool_call> trailing text";
    const cleaned = sanitizeGarbledSummary(raw);
    expect(cleaned).toBe("Leading text  trailing text");
  });
});
