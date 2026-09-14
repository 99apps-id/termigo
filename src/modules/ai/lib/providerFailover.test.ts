import { beforeEach, describe, expect, it } from "vitest";
import {
  getRemainingCooldownMs,
  isProviderAvailable,
  isRateLimitError,
  recordProviderError,
  recordProviderSuccess,
  resetProviderRegistry,
  selectActiveProvider,
} from "./providerFailover";

describe("providerFailover", () => {
  beforeEach(() => {
    resetProviderRegistry();
  });

  it("identifies rate limit and quota exhaustion error strings", () => {
    expect(isRateLimitError("Error: 429 Too Many Requests")).toBe(true);
    expect(isRateLimitError(new Error("rate_limit_exceeded: TPM limit reached"))).toBe(true);
    expect(isRateLimitError("quota exceeded for this billing period")).toBe(true);
    expect(isRateLimitError("Connection timed out: ECONNRESET")).toBe(false);
  });

  it("marks provider as unavailable when rate limited and calculates remaining cooldown", () => {
    const provider = "anthropic-primary";
    const now = 1000000;

    expect(isProviderAvailable(provider, now)).toBe(true);

    // Record 429 error with 30s cooldown
    recordProviderError(provider, new Error("HTTP 429: Too Many Requests"), 30_000);

    // Should be unavailable at now + 5s
    expect(isProviderAvailable(provider, Date.now() + 5_000)).toBe(false);
    expect(getRemainingCooldownMs(provider, Date.now() + 5_000)).toBeGreaterThan(0);

    // Success clears rate limit
    recordProviderSuccess(provider);
    expect(isProviderAvailable(provider, now)).toBe(true);
    expect(getRemainingCooldownMs(provider, now)).toBe(0);
  });

  it("selects primary when healthy and switches to fallback when primary is throttled", () => {
    const primary = ["claude-3-7-sonnet"];
    const fallbacks = ["gpt-4o", "openrouter-claude"];

    // 1. Initial state: primary is chosen
    const res1 = selectActiveProvider(primary, fallbacks);
    expect(res1.selectedProvider).toBe("claude-3-7-sonnet");
    expect(res1.isFallback).toBe(false);

    // 2. Primary throttled: falls back to first available fallback
    recordProviderError("claude-3-7-sonnet", new Error("429 Rate limit reached"), 60_000);

    const res2 = selectActiveProvider(primary, fallbacks);
    expect(res2.selectedProvider).toBe("gpt-4o");
    expect(res2.isFallback).toBe(true);

    // 3. First fallback also throttled: falls back to second fallback
    recordProviderError("gpt-4o", new Error("insufficient_quota"), 60_000);

    const res3 = selectActiveProvider(primary, fallbacks);
    expect(res3.selectedProvider).toBe("openrouter-claude");
    expect(res3.isFallback).toBe(true);
  });
});
