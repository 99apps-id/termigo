// Poll-loop recovery policy.
//
// Three bugs lived here, and all three made the relay look like it had hung:
//
//   1. The stall watchdog aborted the hanging fetch and started a replacement
//      poller in the same tick. While the old request stayed alive Telegram saw
//      two clients on one bot token and answered 409 "terminated by other
//      getUpdates request", so each recovery caused the next stall. Observed in
//      the field as `stalled 188s -> recycle ... 409 Conflict ... stalled 91s`.
//   2. A 409 was retried after the generic 5s, which is precisely what keeps two
//      pollers terminating each other.
//   3. A 409 backoff was invisible to the stall watchdog, because the only thing
//      that updated the stall clock was a SUCCESSFUL poll. So the watchdog fired
//      in the middle of every conflict backoff and its replacement re-acquired
//      the bot immediately - defeating the backoff, which exists to give the
//      other client room. Observed as `409 -> stalled 89s -> recycle -> 409 ->
//      stalled 90s -> recycle`, repeating for as long as the competitor was up.
//
// The timing policy is now a pure function so it can be asserted without a
// network, a chat, or a fake clock.

import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramApiError } from "./telegramApi";
import {
  isPollingStalled,
  isPollTimeoutError,
  POLLING_STALL_TIMEOUT_MS,
  pollBackoffMs,
  TELEGRAM_CONFLICT_BACKOFF_ESCALATED_MS,
  TELEGRAM_CONFLICT_BACKOFF_MS,
  TELEGRAM_CONFLICT_ESCALATE_AFTER,
  TELEGRAM_GENERIC_BACKOFF_BASE_MS,
  TELEGRAM_GENERIC_BACKOFF_CAP_MS,
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

  it("doubles the wait while ordinary failures repeat, capped at a minute", () => {
    // The field log showed `retrying in 5s` every 5s for hours while offline.
    const err = new Error("Failed to fetch");
    expect(pollBackoffMs(err)).toBe(TELEGRAM_GENERIC_BACKOFF_BASE_MS);
    expect(pollBackoffMs(err, 2)).toBe(10_000);
    expect(pollBackoffMs(err, 3)).toBe(20_000);
    expect(pollBackoffMs(err, 4)).toBe(40_000);
    expect(pollBackoffMs(err, 5)).toBe(TELEGRAM_GENERIC_BACKOFF_CAP_MS);
    expect(pollBackoffMs(err, 100)).toBe(TELEGRAM_GENERIC_BACKOFF_CAP_MS);
  });

  it("sanitises a nonsense streak length back to the base wait", () => {
    const err = new Error("Failed to fetch");
    expect(pollBackoffMs(err, 0)).toBe(TELEGRAM_GENERIC_BACKOFF_BASE_MS);
    expect(pollBackoffMs(err, -3)).toBe(TELEGRAM_GENERIC_BACKOFF_BASE_MS);
    expect(pollBackoffMs(err, Number.NaN)).toBe(
      TELEGRAM_GENERIC_BACKOFF_BASE_MS,
    );
  });

  it("keeps server-directed waits independent of the streak", () => {
    expect(
      pollBackoffMs(new TelegramApiError(429, "Too Many Requests", 30), 9),
    ).toBe(30_000);
    expect(
      pollBackoffMs(
        new TelegramApiError(409, "Conflict: terminated by other getUpdates"),
        9,
      ),
    ).toBe(TELEGRAM_CONFLICT_BACKOFF_MS);
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

describe("isPollingStalled", () => {
  it("is not a stall inside the window", () => {
    expect(
      isPollingStalled({
        now: 10_000,
        lastProgressAt: 0,
        deliberateWaitUntil: 0,
      }),
    ).toBe(false);
  });

  it("is a stall once the window passes with nothing declared", () => {
    expect(
      isPollingStalled({
        now: POLLING_STALL_TIMEOUT_MS + 1,
        lastProgressAt: 0,
        deliberateWaitUntil: 0,
      }),
    ).toBe(true);
  });

  it("does not fire exactly at the window", () => {
    // The threshold is `>`, so the boundary itself is still healthy. Pinned
    // because a flip here would make the behaviour depend on tick alignment.
    expect(
      isPollingStalled({
        now: POLLING_STALL_TIMEOUT_MS,
        lastProgressAt: 0,
        deliberateWaitUntil: 0,
      }),
    ).toBe(false);
  });

  // The field failure, in its real numbers. A successful long-poll returns
  // every ~30s (server timeout=30), the 409 backoff is 60s, and the window is
  // 75s - so the backoff does not end until 90s after the last success, and the
  // window was already crossed 15s before that. The old code recycled inside
  // that gap; the log line it wrote said "for 89s", which is the figure used
  // here. Both halves are asserted: the naive condition really was true, and
  // the declared wait is what stops it.
  it("does not call a declared 409 backoff a stall", () => {
    const lastSuccess = 0;
    const backoffStartsAt = 30_000;
    const waitUntil = backoffStartsAt + TELEGRAM_CONFLICT_BACKOFF_MS; // 90_000
    const observed = 89_000; // the elapsed value in the field log line

    // The condition the old implementation used, which fired at this moment:
    expect(observed - lastSuccess).toBeGreaterThan(POLLING_STALL_TIMEOUT_MS);
    expect(waitUntil).toBeGreaterThan(POLLING_STALL_TIMEOUT_MS);

    expect(
      isPollingStalled({
        now: observed,
        lastProgressAt: lastSuccess,
        deliberateWaitUntil: waitUntil,
      }),
    ).toBe(false);
    // And right up to the end of the wait, not merely at one sampled moment.
    expect(
      isPollingStalled({
        now: waitUntil - 1,
        lastProgressAt: lastSuccess,
        deliberateWaitUntil: waitUntil,
      }),
    ).toBe(false);
  });

  // The fix must not quietly depend on the backoff being shorter than the
  // window. A wait longer than the window is still a wait.
  it("suppresses a declared wait longer than the stall window", () => {
    expect(
      isPollingStalled({
        now: POLLING_STALL_TIMEOUT_MS * 2,
        lastProgressAt: 0,
        deliberateWaitUntil: POLLING_STALL_TIMEOUT_MS * 3,
      }),
    ).toBe(false);
  });

  // Suppression has to end, or a loop that dies right after a backoff would
  // never be recovered.
  it("treats a finished wait as no protection", () => {
    const waitUntil = 60_000;
    expect(
      isPollingStalled({
        now: waitUntil + POLLING_STALL_TIMEOUT_MS + 1,
        lastProgressAt: 0,
        deliberateWaitUntil: waitUntil,
      }),
    ).toBe(true);
  });
});

// The update offset is the bot's only record of what it has already handled.
//
// Telegram keeps an unconfirmed update for ~24h and redelivers it on the next
// `getUpdates`, so a module-level offset that reset to 0 on every restart
// replayed the backlog: an old `/run`, `/approve` or `/mode all` ran a second
// time. These pin the persistence that stops it.

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    api: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };
}

describe("telegram update offset persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("restores the stored offset instead of starting from 0", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({ "termigo-telegram-offset": "777" }).api,
    );
    vi.resetModules();
    const mod = await import("./telegramPolling");
    expect(mod.currentUpdateOffset).toBe(777);
  });

  it("ignores a missing or malformed stored offset", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({ "termigo-telegram-offset": "not-a-number" }).api,
    );
    vi.resetModules();
    const mod = await import("./telegramPolling");
    expect(mod.currentUpdateOffset).toBe(0);
  });

  it("persists each advance of the offset", async () => {
    const { api, store } = fakeLocalStorage();
    vi.stubGlobal("localStorage", api);
    vi.resetModules();
    const mod = await import("./telegramPolling");
    mod.setCurrentUpdateOffset(500);
    expect(mod.currentUpdateOffset).toBe(500);
    expect(store.get("termigo-telegram-offset")).toBe("500");
  });

  it("still advances when localStorage is unavailable", async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const mod = await import("./telegramPolling");
    expect(() => mod.setCurrentUpdateOffset(9)).not.toThrow();
    expect(mod.currentUpdateOffset).toBe(9);
  });
});

describe("persistent 409 escalation", () => {
  const conflict = () =>
    new TelegramApiError(409, "Conflict: terminated by other getUpdates");

  it("holds the one-minute stand-down for the first conflicts", () => {
    // A transient double-start (two windows, a restart race) should heal fast,
    // so early conflicts keep the short cycle.
    for (let n = 1; n < TELEGRAM_CONFLICT_ESCALATE_AFTER; n++) {
      expect(pollBackoffMs(conflict(), n)).toBe(TELEGRAM_CONFLICT_BACKOFF_MS);
    }
  });

  it("grows the wait once the competitor is clearly not leaving", () => {
    // The field log showed the 60s cycle repeating for HOURS: two warning
    // lines a minute forever. Past the threshold the poller backs way off -
    // still recovering when the conflict ends, no longer drowning the log.
    expect(pollBackoffMs(conflict(), TELEGRAM_CONFLICT_ESCALATE_AFTER)).toBe(
      TELEGRAM_CONFLICT_BACKOFF_ESCALATED_MS,
    );
    expect(pollBackoffMs(conflict(), 500)).toBe(
      TELEGRAM_CONFLICT_BACKOFF_ESCALATED_MS,
    );
  });
});

describe("isPollTimeoutError", () => {
  it("recognises the apiGet deadline reason", () => {
    expect(isPollTimeoutError(new Error("Timeout after 50000ms"))).toBe(true);
    const dom = new Error("deadline");
    dom.name = "TimeoutError";
    expect(isPollTimeoutError(dom)).toBe(true);
  });

  it("recognises the generic AbortError some webviews surface instead", () => {
    // The field failure: "The user aborted a request." is the client timeout's
    // AbortError on webview builds that do not propagate the abort reason.
    // Classified as a network fault, it marked the bot OFFLINE and escalated
    // the failure streak over what was one slow long-poll.
    const abort = new Error("The user aborted a request.");
    abort.name = "AbortError";
    expect(isPollTimeoutError(abort)).toBe(true);
    expect(isPollTimeoutError(new Error("The user aborted a request."))).toBe(
      true,
    );
  });

  it("leaves real network and API failures alone", () => {
    expect(isPollTimeoutError(new Error("Failed to fetch"))).toBe(false);
    expect(
      isPollTimeoutError(new TelegramApiError(409, "Conflict")),
    ).toBe(false);
    expect(isPollTimeoutError("a string throw")).toBe(false);
    expect(isPollTimeoutError(undefined)).toBe(false);
  });
});
