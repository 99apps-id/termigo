import { describe, expect, it } from "vitest";

import { sanitizeMuseSseLine } from "./museSse";

describe("sanitizeMuseSseLine", () => {
  it("leaves a valid chunk with a choices array untouched", () => {
    const line = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n';
    expect(sanitizeMuseSseLine(line)).toBe(line);
  });

  it("adds an empty choices array to a usage-only tail", () => {
    expect(
      sanitizeMuseSseLine('data: {"usage":{"total_tokens":12}}\n'),
    ).toBe('data: {"usage":{"total_tokens":12},"choices":[]}\n');
  });

  it("fixes a null choices value", () => {
    expect(sanitizeMuseSseLine('data: {"choices":null,"id":"x"}\n')).toBe(
      'data: {"choices":[],"id":"x"}\n',
    );
  });

  it("passes a real error event through so it still surfaces", () => {
    const line = 'data: {"error":{"message":"model_not_found"}}\n';
    expect(sanitizeMuseSseLine(line)).toBe(line);
  });

  it("leaves [DONE], non-data lines and malformed JSON untouched", () => {
    expect(sanitizeMuseSseLine("data: [DONE]\n")).toBe("data: [DONE]\n");
    expect(sanitizeMuseSseLine("event: ping\n")).toBe("event: ping\n");
    expect(sanitizeMuseSseLine("\n")).toBe("\n");
    expect(sanitizeMuseSseLine("data: not json\n")).toBe("data: not json\n");
  });

  it("preserves CRLF endings", () => {
    expect(sanitizeMuseSseLine('data: {"usage":{}}\r\n')).toBe(
      'data: {"usage":{},"choices":[]}\r\n',
    );
  });
});
