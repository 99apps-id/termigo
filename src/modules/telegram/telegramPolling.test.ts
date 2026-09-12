// Poll-loop recovery policy.
//
// Two bugs lived here, and both made the relay look like it had hung:
//
//   1. The stall watchdog aborted the hanging fetch and started a replacement
//      poller in the same tick. While the old request stayed alive Telegram saw
//      two clients on one bot token and answered 409 "terminated by other
//      getUpdates request", so each recovery caused the next stall. Observed in
//      the field as `stalled 188s -> recycle ... 409 Conflict ... stalled 91s`.
//   2. A 409 was retried after the generic 5s, which is precisely what keeps two
//      pollers terminating each other.
//
// The timing policy is now a pure function so it can be asserted without a
// network, a chat, or a fake clock.

import { describe, expect, it } from "vitest";
import { TelegramApiError } from "./telegramApi";
import {
  POLLING_STALL_TIMEOUT_MS,
  pollBackoffMs,
  TELEGRAM_CONFLICT_BACKOFF_MS,
} from "./telegramPolling";

describe("pollBackoffMs", () => {
  it("honours the retry hint on a 429", () => {
    expect(pollBackoffMs(new TelegramApiError(429, "Too Many Requests", 30))).toBe(
      30_000,
    );
  });

  it("still waits a little when a 429 carries no hint", () => {
    expect(pollBackoffMs(new TelegramApiError(429, "Too Many Requests"))).toBe(
      5_000,
    );
  });

  it("never backs off less than a second on a 429", () => {
    // A server hint of 0 (or a missing one) must not become a hot retry loop.
    expect(pollBackoffMs(new TelegramApiError(429, "Too Many Requests", 0))).toBe(
      1_000,
    );
  });

  it("stands down for a minute on a 409, unlike every other failure", () => {
    // A conflict means another client holds the bot. Retrying in 5s is what
    // makes two pollers fight, so this must be much longer than the default.
    const backoff = pollBackoffMs(
      new TelegramApiError(409, "Conflict: terminated by other getUpdates"),
    );
    expect(backoff).toBe(TELEGRAM_CONFLICT_BACKOFF_MS);
    expect(backoff).toBeGreaterThan(30_000);
  });

  it("uses a short retry for an ordinary transport failure", () => {
    expect(pollBackoffMs(new Error("Fetch is aborted"))).toBe(5_000);
    expect(pollBackoffMs("a string throw")).toBe(5_000);
    expect(pollBackoffMs(new TelegramApiError(500, "Internal"))).toBe(5_000);
  });

  it("keeps the stall window long enough that a normal 30s long-poll is not a stall", () => {
    // The poll asks for a 30s server-side wait with a 45s client timeout, so a
    // healthy-but-slow cycle must never trip the watchdog.
    expect(POLLING_STALL_TIMEOUT_MS).toBeGreaterThan(45_000);
  });
});
