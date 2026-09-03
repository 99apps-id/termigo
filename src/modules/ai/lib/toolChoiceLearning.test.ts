// The bug: a custom OpenAI-compatible endpoint running a Qwen-style thinking
// model answered the forced fan-out pin with HTTP 400 —
//   "The tool_choice parameter does not support being set to required or
//    object in thinking mode"
// — and the request dead-ended on a raw red error card. The classifier feeds
// the auto-retry in chatRuntime; the learned set feeds the pin decision in
// agent.ts.
import { beforeEach, describe, expect, it } from "vitest";
import {
  isToolChoiceRejectionError,
  modelRejectsForcedToolChoice,
  recordToolChoiceRejection,
  resetToolChoiceLearning,
} from "./toolChoiceLearning";

const REJECT =
  'data: {"error":{"code":"invalid_parameter_error","param":null,"message":"The tool_choice parameter does not support being set to required or object in thinking mode","type":"invalid_request_error"}}';

beforeEach(() => resetToolChoiceLearning());

describe("isToolChoiceRejectionError", () => {
  it("recognises the provider's rejection", () => {
    expect(isToolChoiceRejectionError(REJECT)).toBe(true);
    expect(
      isToolChoiceRejectionError(
        "The tool_choice parameter does not support being set to required or object in thinking mode",
      ),
    ).toBe(true);
  });

  it("recognises a prose phrasing without the parameter name", () => {
    expect(
      isToolChoiceRejectionError("This model does not support tool choice"),
    ).toBe(true);
  });

  it("does not fire on unrelated provider errors", () => {
    expect(isToolChoiceRejectionError("429 rate limit")).toBe(false);
    expect(
      isToolChoiceRejectionError(
        "maximum context length is 262144 tokens, requested 711017",
      ),
    ).toBe(false);
    expect(isToolChoiceRejectionError("invalid api key")).toBe(false);
    expect(isToolChoiceRejectionError("")).toBe(false);
  });
});

describe("recordToolChoiceRejection", () => {
  it("learns per model id", () => {
    expect(modelRejectsForcedToolChoice("compat-f1023402")).toBe(false);
    recordToolChoiceRejection("compat-f1023402");
    expect(modelRejectsForcedToolChoice("compat-f1023402")).toBe(true);
    // Another model is unaffected — the rejection is an endpoint property.
    expect(modelRejectsForcedToolChoice("compat-4a7c8e83")).toBe(false);
  });

  it("ignores an empty model id", () => {
    recordToolChoiceRejection("");
    expect(modelRejectsForcedToolChoice("")).toBe(false);
  });
});
