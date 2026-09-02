import { describe, expect, it } from "vitest";
import { humanizeModelError } from "./errorMessage";

describe("humanizeModelError", () => {
  it("explains a context-length overflow", () => {
    const out = humanizeModelError(
      "This model's maximum context length is 262144 tokens. However, you requested 262165 tokens.",
    );
    expect(out.toLowerCase()).toContain("too long");
    expect(out.toLowerCase()).toContain("continue");
  });

  it("explains an exhausted quota", () => {
    expect(
      humanizeModelError(
        "429 insufficient_quota: You exceeded your current quota",
      ).toLowerCase(),
    ).toContain("quota");
  });

  it("explains rate limiting", () => {
    expect(humanizeModelError("Rate limit reached").toLowerCase()).toContain(
      "rate-limit",
    );
  });

  it("explains a rejected key", () => {
    expect(
      humanizeModelError("401 Unauthorized: invalid api key").toLowerCase(),
    ).toContain("key");
  });

  it("explains the no-first-token watchdog", () => {
    expect(
      humanizeModelError("model did not respond within 90s").toLowerCase(),
    ).toContain("stopped responding");
  });

  it("explains a provider content-moderation rejection", () => {
    const out = humanizeModelError(
      'data: {"error":{"code":"data_inspection_failed","param":null,"message":"Input text data may contain inappropriate content.","type":"data_inspection_failed"}}',
    ).toLowerCase();
    expect(out).toContain("content filter");
    // The actionable part: retrying the same content is futile.
    expect(out).toContain("will fail again");
    // It must not be misread as a key problem (these ride a 4xx status).
    expect(out).not.toContain("api key");
  });

  it("passes an unrecognised message through", () => {
    expect(humanizeModelError("Some novel provider error")).toBe(
      "Some novel provider error",
    );
  });

  it("never returns empty", () => {
    expect(humanizeModelError("").length).toBeGreaterThan(0);
    expect(humanizeModelError(null).length).toBeGreaterThan(0);
  });
});
