import { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  formatAiError,
  isConnectivityError,
  isQuotaError,
  isRateLimitError,
} from "./errors";

describe("formatAiError", () => {
  it("surfaces nested provider model errors", () => {
    expect(
      formatAiError({
        type: "error",
        sequence_number: 2,
        error: {
          code: "model_not_found",
          message:
            "The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
          type: "invalid_request_error",
        },
      }),
    ).toBe(
      "Model unavailable: The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
    );
  });

  it("extracts structured response bodies from SDK errors", () => {
    expect(
      formatAiError({
        message: "Bad Request",
        responseBody: JSON.stringify({
          error: {
            code: "rate_limit_exceeded",
            message: "Please retry after 10 seconds.",
          },
        }),
      }),
    ).toBe("Rate limit reached: Please retry after 10 seconds.");
  });

  it("preserves useful local errors", () => {
    expect(formatAiError(new Error("No API key configured for OpenAI."))).toBe(
      "No API key configured for OpenAI.",
    );
  });

  it("redacts credential-like values", () => {
    expect(
      formatAiError(
        new Error(
          "Authorization Bearer secret-token-value and key sk-ant-abcdefghijklmnop were rejected.",
        ),
      ),
    ).toBe("Authorization Bearer [redacted] and key [redacted] were rejected.");
  });

  it("uses an actionable fallback for unknown error shapes", () => {
    expect(formatAiError({ unexpected: true })).toBe(
      "The AI provider rejected the request. Check the selected model and provider settings, then try again.",
    );
  });

  it("preserves provider details through the AI SDK UI stream", async () => {
    const providerError = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        message:
          "The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
      },
    };
    const model = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "error", error: providerError });
            controller.close();
          },
        }),
      },
    });
    const result = streamText({
      model,
      prompt: "hello",
      onError: () => {},
    });
    const chunks = [];
    for await (const chunk of result.toUIMessageStream({
      onError: formatAiError,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      type: "error",
      errorText:
        "Model unavailable: The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
    });
  });
});

describe("transient/recoverable error classifiers", () => {
  it("recognises connectivity errors", () => {
    expect(
      isConnectivityError(
        "Cannot connect to API: client error (Connect): tcp connect error: A socket operation was attempted to an unreachable host. (os error 10065)",
      ),
    ).toBe(true);
    expect(isConnectivityError("fetch failed: ENETUNREACH")).toBe(true);
    expect(isConnectivityError("Connection refused")).toBe(true);
    expect(
      isConnectivityError(
        "Failed after 3 attempts. Last error: Cannot connect to API: provider did not respond within 90s",
      ),
    ).toBe(true);
  });

  it("rejects non-connectivity errors", () => {
    expect(isConnectivityError("The model is in limited preview.")).toBe(false);
    expect(isConnectivityError("Invalid API key.")).toBe(false);
  });

  it("recognises quota / credit errors", () => {
    expect(
      isQuotaError("Error: insufficient_quota, you have no credits left"),
    ).toBe(true);
    expect(isQuotaError("402 Payment Required: out of tokens")).toBe(true);
    expect(isQuotaError("Rate limit reached.")).toBe(false);
  });

  it("recognises rate limit errors", () => {
    expect(
      isRateLimitError("rate_limit_exceeded: Please retry after 10s"),
    ).toBe(true);
    expect(isRateLimitError("429 Too Many Requests")).toBe(true);
    expect(isRateLimitError("Invalid API key.")).toBe(false);
  });
});
