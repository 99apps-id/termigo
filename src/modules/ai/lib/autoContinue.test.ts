import { describe, expect, it } from "vitest";
import {
  AUTO_CONTINUE_DELAY_MS,
  autoContinueSlot,
  MAX_AUTO_CONTINUES,
} from "./autoContinue";

describe("autoContinueSlot", () => {
  it("allows continues up to the budget", () => {
    for (let used = 0; used < MAX_AUTO_CONTINUES; used++) {
      expect(autoContinueSlot(used)).toBe(true);
    }
    expect(autoContinueSlot(MAX_AUTO_CONTINUES)).toBe(false);
    expect(autoContinueSlot(MAX_AUTO_CONTINUES + 5)).toBe(false);
  });

  it("honours a custom max", () => {
    expect(autoContinueSlot(0, 2)).toBe(true);
    expect(autoContinueSlot(1, 2)).toBe(true);
    expect(autoContinueSlot(2, 2)).toBe(false);
  });

  it("delays the resume so the UI settles and a Stop can land", () => {
    expect(AUTO_CONTINUE_DELAY_MS).toBeGreaterThan(0);
    expect(AUTO_CONTINUE_DELAY_MS).toBeLessThan(10_000);
  });
});
