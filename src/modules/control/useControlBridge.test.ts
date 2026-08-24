import { describe, expect, it } from "vitest";
import { parseFocusRequest, parseOpenRequest } from "./useControlBridge";

describe("parseOpenRequest", () => {
  it("defaults focus only when it is absent", () => {
    expect(parseOpenRequest({ path: "/repo/main.rs" }).focus).toBe(true);
    expect(
      parseOpenRequest({ path: "/repo/main.rs", focus: false }).focus,
    ).toBe(false);
  });

  it.each([0, "false", null, {}])(
    "rejects non-boolean focus value %o",
    (focus) => {
      expect(() => parseOpenRequest({ path: "/repo/main.rs", focus })).toThrow(
        "focus must be a boolean",
      );
    },
  );
});

describe("parseFocusRequest", () => {
  it("requires a non-empty query", () => {
    expect(parseFocusRequest({ query: "src/App.tsx" })).toEqual({
      query: "src/App.tsx",
    });
    expect(() => parseFocusRequest({ query: "" })).toThrow(
      "focus query is required",
    );
    expect(() => parseFocusRequest({ query: "   " })).toThrow(
      "focus query is required",
    );
    expect(() => parseFocusRequest(null)).toThrow(
      "focus parameters are required",
    );
    expect(() => parseFocusRequest({})).toThrow("focus query is required");
  });
});
