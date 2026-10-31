import { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { withCodexBackendDefaults } from "./agent";

// The ChatGPT backend refuses a Responses request whose `store` is not
// explicitly false (see withCodexBackendDefaults in agent.ts). These tests
// pin the mechanism: the default must reach the provider's call options for
// every call made with the built model, without overriding a caller's own
// provider options.
function failingStreamModel() {
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
  model: MockLanguageModelV3,
  providerOptions?: Record<string, Record<string, string>>,
) {
  const result = streamText({
    model: withCodexBackendDefaults(model),
    prompt: "hello",
    ...(providerOptions ? { providerOptions } : {}),
    onError: () => {},
  });
  await result.consumeStream().catch(() => {});
  expect(model.doStreamCalls).toHaveLength(1);
  return model.doStreamCalls[0];
}

describe("withCodexBackendDefaults", () => {
  it("sends store: false to the OpenAI provider on every call", async () => {
    const options = await firstCallOptions(failingStreamModel());
    expect(options.providerOptions).toMatchObject({
      openai: { store: false },
    });
  });

  it("keeps a caller's own OpenAI options alongside the default", async () => {
    const options = await firstCallOptions(failingStreamModel(), {
      openai: { reasoningEffort: "low" },
    });
    expect(options.providerOptions).toMatchObject({
      openai: { store: false, reasoningEffort: "low" },
    });
  });

  it("passes a non-v3 model through untouched", () => {
    expect(withCodexBackendDefaults("some-model-id")).toBe("some-model-id");
  });

  it("keeps the wrapped model's identity", () => {
    const model = failingStreamModel();
    const wrapped = withCodexBackendDefaults(model);
    expect((wrapped as { modelId?: string }).modelId).toBe(model.modelId);
    expect((wrapped as { provider?: string }).provider).toBe(model.provider);
  });
});
