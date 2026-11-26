import { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { withClaudeDefaults } from "./agent";

// The AI SDK gives a Claude id it was not built with (claude-opus-5-5,
// claude-haiku-5-5) a 4096-token ceiling, which cuts a long step or a tool
// call off mid-JSON. These tests pin the mechanism that replaces it with the
// model's real ceiling and makes adaptive thinking visible.
function model() {
  return new MockLanguageModelV3({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "error", error: new Error("boom") });
          controller.close();
        },
      }),
    },
  });
}

async function firstCallOptions(
  mock: MockLanguageModelV3,
  apiModelId: string,
  extra: Record<string, unknown> = {},
) {
  const result = streamText({
    model: withClaudeDefaults(mock, apiModelId),
    prompt: "hello",
    onError: () => {},
    ...extra,
  });
  await result.consumeStream().catch(() => {});
  expect(mock.doStreamCalls).toHaveLength(1);
  return mock.doStreamCalls[0];
}

describe("withClaudeDefaults", () => {
  it("lifts a model the SDK does not know to its real output ceiling", async () => {
    for (const id of ["claude-opus-5-5", "claude-haiku-5-5"]) {
      const options = await firstCallOptions(model(), id);
      expect(options.maxOutputTokens, id).toBe(128_000);
    }
  });

  it("asks for adaptive thinking with the reasoning returned as text", async () => {
    const options = await firstCallOptions(model(), "claude-sonnet-5-5");
    expect(options.providerOptions).toMatchObject({
      anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    });
  });

  it("keeps the caller's own ceiling", async () => {
    const options = await firstCallOptions(model(), "claude-haiku-5-5", {
      maxOutputTokens: 48,
    });
    expect(options.maxOutputTokens).toBe(48);
  });

  it("does not ask a model without adaptive thinking for it", async () => {
    const options = await firstCallOptions(model(), "claude-sonnet-4-5");
    expect(options.maxOutputTokens).toBe(64_000);
    expect(options.providerOptions?.anthropic?.thinking).toBeUndefined();
  });

  it("leaves an id it has no data for untouched", async () => {
    const mock = model();
    expect(withClaudeDefaults(mock, "claude-3-haiku-20240307")).toBe(mock);
    expect(withClaudeDefaults(mock, "gpt-6-sol")).toBe(mock);
  });
});
