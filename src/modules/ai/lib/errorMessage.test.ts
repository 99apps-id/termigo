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

    expect(
      humanizeModelError(
        "Failed after 3 attempts. Last error: Your token-plan 1-week quota has been exhausted. The quota will reset at 09-22 11:19:00 UTC.",
      ).toLowerCase(),
    ).toContain("quota");
  });

  it("explains tool input validation failure", () => {
    expect(
      humanizeModelError(
        'Invalid input for tool bash_run: Type validation failed: Value: {"command":"node scripts/test.js","timeout_secs":900}.',
      ).toLowerCase(),
    ).toContain("tool received invalid input");
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

  // The ordering bug this pins: every watchdog abort message contains
  // "timed out", and the network branch also matches "timed out". When the
  // network branch ran first, a healthy machine was told to "check your
  // internet connection" after an approved `cargo test` outlived the watchdog
  // (field log 2026-09-19: `tool execution exceeded 120s ... elapsed=464s`).
  it("explains an approved-tool watchdog abort as a tool stall, not a network fault", () => {
    const out = humanizeModelError(
      "Approved tool execution timed out after 464s without completing.",
    ).toLowerCase();
    expect(out).toContain("watchdog");
    expect(out).toContain("not a network problem");
    expect(out).not.toContain("internet connection");
  });

  it("explains a silent-tool watchdog abort as a tool stall, not a network fault", () => {
    const out = humanizeModelError(
      "A tool did not complete or show activity within 120s. The run was stopped to avoid hanging forever.",
    ).toLowerCase();
    expect(out).toContain("not a network problem");
    expect(out).not.toContain("internet connection");
  });

  it("explains a silent-model watchdog abort without blaming the network", () => {
    const out = humanizeModelError(
      "The model stopped responding (no output for 90s).",
    ).toLowerCase();
    expect(out).toContain("stopped responding");
    expect(out).not.toContain("internet connection");
  });

  it("still reports a genuine network timeout as a network fault", () => {
    // The stall branch must not swallow real connectivity failures: they carry
    // no watchdog phrasing, so the network branch still owns them.
    expect(
      humanizeModelError("The operation timed out.").toLowerCase(),
    ).toContain("internet connection");
  });

  it("explains a thinking-mode rejection of a forced tool choice", () => {
    const out = humanizeModelError(
      'data: {"error":{"code":"invalid_parameter_error","param":null,"message":"The tool_choice parameter does not support being set to required or object in thinking mode","type":"invalid_request_error"}}',
    ).toLowerCase();
    expect(out).toContain("forcing a specific tool call");
    // The actionable part: the pin is dropped, a retry works.
    expect(out).toContain("try again");
    // Plain language: no internal jargon on screen.
    expect(out).not.toContain("pin");
    expect(out).not.toContain("provider");
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

  it("explains concurrency throttling", () => {
    expect(
      humanizeModelError("concurrency reached, current: 9, limit: 8").toLowerCase(),
    ).toContain("rate-limit");
  });

  it("handles empty retry error wrappers gracefully", () => {
    const out = humanizeModelError("AI_RetryError: Failed after 3 attempts. Last error:");
    expect(out.toLowerCase()).toContain("failed after multiple retry attempts");
  });

  it("unwraps and humanizes inner errors inside retry wrappers", () => {
    const out = humanizeModelError(
      "AI_RetryError: Failed after 3 attempts. Last error: concurrency reached, current: 9, limit: 8",
    );
    expect(out.toLowerCase()).toContain("rate-limit");
  });

  it("sanitizes raw HTML error responses from proxies", () => {
    const html = "<!DOCTYPE html><html lang=\"en\"><head><title>404 Not Found</title></head><body>Error</body></html>";
    const out = humanizeModelError(html);
    expect(out.toLowerCase()).toContain("html web page");
    expect(out.toLowerCase()).not.toContain("<!doctype");
  });

  it("explains unavailable or missing models (404/410)", () => {
    const out404 = humanizeModelError("The provider returned status 404");
    expect(out404.toLowerCase()).toContain("not found");

    const out410 = humanizeModelError("Request failed with status 410");
    expect(out410.toLowerCase()).toContain("not found");
  });

  it("never returns empty", () => {
    expect(humanizeModelError("").length).toBeGreaterThan(0);
    expect(humanizeModelError(null).length).toBeGreaterThan(0);
  });
});
