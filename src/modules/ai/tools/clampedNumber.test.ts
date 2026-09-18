import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clampedInt } from "./clampedNumber";

describe("clampedInt", () => {
  const schema = z.object({
    timeout_secs: clampedInt(1, 900),
    lines: clampedInt(1, 2000, 80),
  });

  it("accepts valid integers within range", () => {
    const result = schema.parse({ timeout_secs: 120, lines: 100 });
    expect(result.timeout_secs).toBe(120);
    expect(result.lines).toBe(100);
  });

  it("clamps numbers exceeding the maximum without throwing", () => {
    const result = schema.parse({ timeout_secs: 1800, lines: 5000 });
    expect(result.timeout_secs).toBe(900);
    expect(result.lines).toBe(2000);
  });

  it("clamps numbers below the minimum without throwing", () => {
    const result = schema.parse({ timeout_secs: -10, lines: 0 });
    expect(result.timeout_secs).toBe(1);
    expect(result.lines).toBe(1);
  });

  it("parses numeric strings and clamps them safely", () => {
    const result = schema.parse({ timeout_secs: "900", lines: "50" });
    expect(result.timeout_secs).toBe(900);
    expect(result.lines).toBe(50);
  });

  it("uses default value when optional field with default is omitted", () => {
    const result = schema.parse({});
    expect(result.timeout_secs).toBeUndefined();
    expect(result.lines).toBe(80);
  });

  it("rounds floating point numbers to integers", () => {
    const result = schema.parse({ timeout_secs: 45.8 });
    expect(result.timeout_secs).toBe(45);
  });
});
