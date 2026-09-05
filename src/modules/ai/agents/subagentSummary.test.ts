import { describe, expect, it, vi } from "vitest";
import { safeJson, synthesizeSummary } from "./subagentSummary";

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
