import { describe, expect, it } from "vitest";

import { CODE_SETTLE_MS, isCodeSettled } from "./chat-code";

describe("isCodeSettled", () => {
  it("is always settled once the part stops streaming", () => {
    expect(isCodeSettled(false, 0)).toBe(true);
    expect(isCodeSettled(false, 1)).toBe(true);
  });

  it("keeps a still-changing block unsettled while streaming", () => {
    expect(isCodeSettled(true, 0)).toBe(false);
    expect(isCodeSettled(true, CODE_SETTLE_MS - 1)).toBe(false);
  });

  it("settles a block the model has moved past", () => {
    expect(isCodeSettled(true, CODE_SETTLE_MS)).toBe(true);
    expect(isCodeSettled(true, CODE_SETTLE_MS + 500)).toBe(true);
  });
});
