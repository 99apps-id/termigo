import { describe, expect, it } from "vitest";
import {
  parseAgentRunRequest,
  parseFocusRequest,
  parseOpenRequest,
  parsePentestReportRequest,
  parsePentestRunRequest,
} from "./useControlBridge";

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

describe("parsePentestRunRequest", () => {
  it("reads the target and an optional category, trimmed", () => {
    expect(parsePentestRunRequest({ target: " example.com " })).toEqual({
      target: "example.com",
      category: "",
    });
    expect(
      parsePentestRunRequest({ target: "10.0.0.5", category: " web " }),
    ).toEqual({ target: "10.0.0.5", category: "web" });
  });

  it("rejects a missing or blank target", () => {
    expect(() => parsePentestRunRequest({})).toThrow(
      "pentest target is required",
    );
    expect(() => parsePentestRunRequest({ target: "" })).toThrow(
      "pentest target is required",
    );
    expect(() => parsePentestRunRequest({ target: "   " })).toThrow(
      "pentest target is required",
    );
    expect(() => parsePentestRunRequest(null)).toThrow(
      "pentest-run parameters are required",
    );
  });
});

describe("parsePentestReportRequest", () => {
  it("reads an optional target, trimmed", () => {
    expect(parsePentestReportRequest({ target: " example.com " })).toEqual({
      target: "example.com",
    });
    // Empty target = "the last pentest-run target".
    expect(parsePentestReportRequest({ target: "" })).toEqual({ target: "" });
    expect(parsePentestReportRequest({})).toEqual({ target: "" });
  });

  it("rejects a non-object payload", () => {
    expect(() => parsePentestReportRequest(null)).toThrow(
      "pentest-report parameters are required",
    );
  });
});

describe("parseAgentRunRequest", () => {
  it("reads the trimmed prompt", () => {
    expect(parseAgentRunRequest({ prompt: "  fix the build  " })).toEqual({
      prompt: "fix the build",
    });
  });

  it("rejects a missing or blank prompt", () => {
    expect(() => parseAgentRunRequest({})).toThrow(
      "agent prompt is required",
    );
    expect(() => parseAgentRunRequest({ prompt: "" })).toThrow(
      "agent prompt is required",
    );
    expect(() => parseAgentRunRequest({ prompt: "   " })).toThrow(
      "agent prompt is required",
    );
    expect(() => parseAgentRunRequest(null)).toThrow(
      "run parameters are required",
    );
  });
});
