import { beforeEach, describe, expect, it } from "vitest";
import {
  effectiveContextLimit,
  isContextOverflowError,
  noteSuccessfulRequest,
  parseContextOverflow,
  recordContextOverflow,
  resetContextLearning,
} from "./contextLimitLearning";

const OVERFLOW =
  "This model's maximum context length is 262144 tokens. However, you requested 711017 tokens (711017 in the messages, 0 in the completion).";

beforeEach(() => resetContextLearning());

describe("parseContextOverflow", () => {
  it("extracts the cap and the requested size", () => {
    expect(parseContextOverflow(OVERFLOW)).toEqual({
      max: 262144,
      requested: 711017,
    });
  });

  it("tolerates commas and a missing requested field", () => {
    expect(
      parseContextOverflow("maximum context length is 1,000,000 tokens"),
    ).toEqual({ max: 1000000, requested: null });
  });
});

describe("isContextOverflowError", () => {
  it("recognises the overflow, not unrelated errors", () => {
    expect(isContextOverflowError(OVERFLOW)).toBe(true);
    expect(isContextOverflowError("429 rate limit")).toBe(false);
  });
});

describe("recordContextOverflow + effectiveContextLimit", () => {
  it("caps the configured limit at the provider's real limit", () => {
    // Configured far too high (1M) but the provider caps at 262144.
    recordContextOverflow("m", OVERFLOW);
    // The overshoot (262144/711017≈0.37) scales the budget well under the cap,
    // so the retry fits in one step.
    const eff = effectiveContextLimit("m", 1_000_000);
    expect(eff).toBeLessThan(262144);
    expect(eff).toBeLessThanOrEqual(Math.floor(262144 * (262144 / 711017)));
  });

  it("leaves an unknown model at its configured limit", () => {
    expect(effectiveContextLimit("other", 256000)).toBe(256000);
  });

  // The loop the user hit: a numberless overflow on a 1M-configured model whose
  // real cap is far lower. It must shrink relative to what just failed, not
  // nudge down from 1M forever, so a click or two converges.
  it("converges on a numberless overflow instead of looping", () => {
    const first = effectiveContextLimit("m", 1_000_000);
    expect(first).toBe(1_000_000);

    recordContextOverflow("m", "context_length_exceeded");
    const second = effectiveContextLimit("m", 1_000_000);
    expect(second).toBeLessThanOrEqual(400_000);
    expect(second).toBeLessThan(first);

    recordContextOverflow("m", "context_length_exceeded");
    const third = effectiveContextLimit("m", 1_000_000);
    expect(third).toBeLessThan(second);
  });

  it("relaxes the scale after a request fits with headroom", () => {
    recordContextOverflow("m", OVERFLOW);
    const tightened = effectiveContextLimit("m", 1_000_000);
    // A later request that used little of the real window eases the scale up.
    noteSuccessfulRequest("m", 20_000);
    noteSuccessfulRequest("m", 20_000);
    noteSuccessfulRequest("m", 20_000);
    expect(effectiveContextLimit("m", 1_000_000)).toBeGreaterThan(tightened);
  });
});
