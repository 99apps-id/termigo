import { describe, expect, it } from "vitest";
import {
  distillTestOutput,
  shouldRetryTest,
  retryGuidance,
  TestAttemptTracker,
} from "./testLoop";

describe("testLoop helper", () => {
  it("distills compiler and test error outputs accurately", () => {
    const rawOutput = `
running 1 test
test modules::test_example ... FAILED

failures:

---- modules::test_example stdout ----
thread 'modules::test_example' panicked at src/modules/agent.rs:42:9:
assertion \`left == right\` failed
  left: 1
 right: 2

failures:
    modules::test_example

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
`;

    const summary = distillTestOutput(rawOutput);
    expect(summary.kind).toBe("test_failure");
    expect(summary.failingFiles).toContain("src/modules/agent.rs");
    expect(summary.lineNumbers).toContain(42);
    expect(summary.distilledOutput).toContain("panicked at");
  });

  it("evaluates shouldRetryTest logic properly", () => {
    expect(shouldRetryTest({ attempt: 1, maxRetries: 3, exitCode: 1 })).toBe(true);
    expect(shouldRetryTest({ attempt: 3, maxRetries: 3, exitCode: 1 })).toBe(false);
    expect(shouldRetryTest({ attempt: 1, maxRetries: 3, exitCode: 0 })).toBe(false);
  });

  it("builds capped retry guidance", () => {
    const under = retryGuidance({ attempt: 1, maxRetries: 3, exitCode: 1 });
    expect(under.shouldRetry).toBe(true);
    expect(under.guidance).toContain("Attempt 1/3");

    const capped = retryGuidance({ attempt: 3, maxRetries: 3, exitCode: 1 });
    expect(capped.shouldRetry).toBe(false);
    expect(capped.guidance).toContain("retry limit");

    const passing = retryGuidance({ attempt: 1, maxRetries: 3, exitCode: 0 });
    expect(passing.shouldRetry).toBe(false);
    expect(passing.guidance).toContain("passed");
  });

  it("tracks per-file attempts and resets on success", () => {
    const tracker = new TestAttemptTracker(3);
    expect(tracker.record("a.test.ts", 1)).toBe(1);
    expect(tracker.record("a.test.ts", 1)).toBe(2);
    expect(tracker.peek("a.test.ts")).toBe(2);
    // A passing run resets the counter.
    expect(tracker.record("a.test.ts", 0)).toBe(0);
    expect(tracker.peek("a.test.ts")).toBe(0);
    // Independent keys are tracked separately.
    expect(tracker.record("b.test.ts", 1)).toBe(1);
    expect(tracker.max).toBe(3);
  });
});
