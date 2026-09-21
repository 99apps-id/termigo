import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markRunActivity,
  msSinceActivity,
  pendingApprovalToolTimeoutMs,
  remainingSilenceMs,
  resetRunActivity,
  STALL_BUDGET_CAP_MS,
  STALL_TIMEOUT_MS,
  STALL_TIMEOUT_ON_RESUME_MS,
  silenceIsFatal,
  stallBudgetMs,
  startActivityHeartbeat,
  TOOL_TIMEOUT_SLACK_MS,
  watchdogDirective,
} from "./streamWatchdog";

describe("watchdogDirective", () => {
  // The regression that caused a real 20-minute hang. A reasoning model streams
  // `reasoning-delta` chunks before it answers; treating one as "the response
  // arrived" cleared the only watchdog, so when the provider then went silent
  // nothing was left to abort the run.
  it("treats a reasoning delta as the model still producing", () => {
    expect(watchdogDirective("reasoning-delta")).toBe("rearm");
  });

  it("restarts the clock on real content", () => {
    expect(watchdogDirective("text-delta")).toBe("rearm");
    expect(watchdogDirective("source")).toBe("rearm");
  });

  it("keeps watching while the model assembles a tool call", () => {
    expect(watchdogDirective("tool-input-start")).toBe("rearm");
    expect(watchdogDirective("tool-input-delta")).toBe("rearm");
  });

  // A tool runs without sending anything, and a long one is normal, so silence
  // during execution must not be mistaken for a stalled provider.
  it("stops watching once a tool is about to execute", () => {
    expect(watchdogDirective("tool-call")).toBe("disarm");
  });

  it("resumes watching once the tool result is back", () => {
    expect(watchdogDirective("tool-result")).toBe("rearm");
  });

  it("has no opinion on chunks it does not recognise", () => {
    expect(watchdogDirective("start")).toBe("ignore");
    expect(watchdogDirective("finish")).toBe("ignore");
    expect(watchdogDirective("error")).toBe("ignore");
    expect(watchdogDirective("something-new")).toBe("ignore");
  });
});

describe("the run's activity clock", () => {
  afterEach(() => {
    resetRunActivity();
    vi.useRealTimers();
  });

  it("reports no activity at all before anything has happened", () => {
    resetRunActivity();
    // Infinity, not 0: "nobody has reported anything yet" must read as
    // definitely wedged, never as "just active".
    expect(msSinceActivity(1_000)).toBe(Number.POSITIVE_INFINITY);
    expect(silenceIsFatal(1_000, STALL_TIMEOUT_MS)).toBe(true);
  });

  it("measures silence from the last report, whatever reported it", () => {
    resetRunActivity();
    markRunActivity(1_000);
    expect(msSinceActivity(1_500)).toBe(500);
    expect(silenceIsFatal(1_500, 1_000)).toBe(false);
    // A later report - a chunk, a tool heartbeat - pushes the deadline out.
    markRunActivity(2_000);
    expect(msSinceActivity(2_500)).toBe(500);
  });

  it("forgets the previous run, so old activity cannot excuse a stall", () => {
    markRunActivity(5_000);
    resetRunActivity();
    expect(msSinceActivity(500_000)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("remainingSilenceMs", () => {
  afterEach(() => resetRunActivity());

  // The fix for the field loop: the timer no longer aborts on its own, it asks
  // the clock. A run that made progress since the arm gets the rest of its
  // budget, so no path that re-arms without a matching disarm can kill live
  // work. The approval resume did exactly that: the `tool-call` chunk that
  // disarms the watchdog belongs to the PREVIOUS run.
  it("grants the rest of the budget when progress landed after the arm", () => {
    expect(remainingSilenceMs(1_000, 90_000, 10_000)).toBe(80_000);
  });

  it("is zero only when the silence really is fatal", () => {
    expect(remainingSilenceMs(1_000, 90_000, 90_000)).toBe(0);
    expect(remainingSilenceMs(1_000, 90_000, 95_000)).toBe(0);
    expect(remainingSilenceMs(1_000, 90_000)).toBe(0);
  });
});

describe("stallBudgetMs", () => {
  const failedTest = (timeoutSecs: number) => [
    {
      role: "assistant",
      parts: [
        {
          type: "tool-bash_run",
          state: "approval-responded",
          input: {
            command: "cd src-tauri; cargo test --locked",
            timeout_secs: timeoutSecs,
          },
        },
      ],
    },
  ];

  it("keeps the plain budget when nothing is being resumed", () => {
    expect(stallBudgetMs([], false)).toBe(STALL_TIMEOUT_MS);
    expect(stallBudgetMs(failedTest(300), false)).toBe(STALL_TIMEOUT_MS);
  });

  // THE regression, 2026-09-15: `cargo test --locked` with `timeout_secs: 300`
  // under a fixed 180s watchdog. The abort always fired first, the tool was
  // killed mid-compile, its own timeout result never reached the model, and the
  // same request was re-sent every ~3 minutes for half an hour.
  it("never arms shorter than the tool the resume is executing", () => {
    expect(stallBudgetMs(failedTest(300), true)).toBe(
      300_000 + TOOL_TIMEOUT_SLACK_MS,
    );
  });

  it("keeps a floor for a resume whose tool declared no timeout", () => {
    expect(stallBudgetMs([], true)).toBe(STALL_TIMEOUT_ON_RESUME_MS);
    const noTimeout = [
      {
        parts: [{ state: "approval-responded", input: { command: "make" } }],
      },
    ];
    expect(stallBudgetMs(noTimeout, true)).toBe(STALL_TIMEOUT_ON_RESUME_MS);
  });

  it("caps an absurd timeout rather than disabling the watchdog", () => {
    expect(stallBudgetMs(failedTest(86_400), true)).toBe(STALL_BUDGET_CAP_MS);
  });

  it("reads a stringified input, since a stored transcript carries one", () => {
    const stored = [
      {
        parts: [
          {
            state: "approval-responded",
            input: JSON.stringify({ timeout_secs: 240 }),
          },
        ],
      },
    ];
    expect(pendingApprovalToolTimeoutMs(stored)).toBe(240_000);
  });

  it("ignores a part that is not an answered approval", () => {
    const other = [{ parts: [{ state: "output-available", input: {} }] }];
    expect(pendingApprovalToolTimeoutMs(other)).toBeNull();
    expect(stallBudgetMs(other, true)).toBe(STALL_TIMEOUT_ON_RESUME_MS);
  });
});

describe("startActivityHeartbeat", () => {
  afterEach(() => {
    resetRunActivity();
    vi.useRealTimers();
  });

  it("marks activity immediately, not only after the first interval", () => {
    resetRunActivity();
    const stop = startActivityHeartbeat({ now: () => 1_000 });
    expect(msSinceActivity(1_000)).toBe(0);
    stop();
  });

  it("keeps the clock fresh while a tool runs", () => {
    vi.useFakeTimers();
    let now = 10_000;
    const stop = startActivityHeartbeat({
      intervalMs: 5_000,
      now: () => now,
    });
    now = 30_000;
    vi.advanceTimersByTime(20_000);
    expect(msSinceActivity(now)).toBe(0);
    stop();
  });

  // Bounded on purpose. A heartbeat that never stops would excuse a genuinely
  // hung tool forever, which is the opposite failure to the one being fixed.
  it("stops excusing a tool once its ceiling is reached", () => {
    vi.useFakeTimers();
    let now = 0;
    const stop = startActivityHeartbeat({
      intervalMs: 1_000,
      maxMs: 5_000,
      now: () => now,
    });
    now = 5_000;
    vi.advanceTimersByTime(5_000);
    const atCeiling = msSinceActivity(now);
    now = 20_000;
    vi.advanceTimersByTime(15_000);
    expect(msSinceActivity(now)).toBeGreaterThan(atCeiling);
    stop();
  });

  it("can be stopped twice without complaint", () => {
    const stop = startActivityHeartbeat();
    stop();
    expect(() => stop()).not.toThrow();
  });
});
