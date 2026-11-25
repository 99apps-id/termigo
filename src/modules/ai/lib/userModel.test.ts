import { describe, expect, it } from "vitest";
import { clampConfidence } from "./userModel";

describe("clampConfidence", () => {
  it("keeps an in-range value", () => {
    expect(clampConfidence(0)).toBe(0);
    expect(clampConfidence(0.5)).toBe(0.5);
    expect(clampConfidence(1)).toBe(1);
  });

  // Confidence used to grow by 0.1 per observation with no ceiling, so after
  // six observations of one key it was 1.1 and kept climbing.
  it("clamps an out-of-range value into 0..1", () => {
    expect(clampConfidence(1.1)).toBe(1);
    expect(clampConfidence(14)).toBe(1);
    expect(clampConfidence(-3)).toBe(0);
  });

  it("treats junk as zero rather than NaN", () => {
    expect(clampConfidence(undefined)).toBe(0);
    expect(clampConfidence(null)).toBe(0);
    expect(clampConfidence("0.9")).toBe(0);
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampConfidence({})).toBe(0);
  });
});
