// The loop breaker for the SDK's automatic approval resume.
//
// The failure this guards against is an endless cycle, not a crash: the model
// re-requests the same approval, the SDK re-sends automatically, the transcript
// never grows, and the run repeats forever. The distinguishing signal is
// progress, so the cases below are about which counts count as progress.

import { describe, expect, it } from "vitest";
import {
  autoSendGate,
  INITIAL_AUTO_SEND_STATE,
  MAX_STALLED_AUTO_SENDS,
} from "./autoSendGate";

/** Feed a sequence of transcript sizes through the gate. */
function run(counts: number[], maxStalled?: number) {
  let state = INITIAL_AUTO_SEND_STATE;
  return counts.map((count) => {
    const decision = autoSendGate(state, count, maxStalled);
    state = decision.state;
    return decision;
  });
}

describe("autoSendGate", () => {
  it("allows a resume that added a tool result", () => {
    const [first] = run([14, 16]);
    expect(first.allow).toBe(true);
    expect(first.stoppedLoop).toBe(false);
  });

  it("keeps allowing while the transcript grows", () => {
    const decisions = run([14, 16, 18, 20, 22, 24]);
    expect(decisions.every((d) => d.allow)).toBe(true);
    expect(decisions.some((d) => d.stoppedLoop)).toBe(false);
  });

  it("stops a run that re-sends without making progress", () => {
    // THE regression: the same transcript size on every cycle. The field log
    // showed `run: start (14 messages)` repeating with `steps 1/25` and
    // `runRound` still 0, so nothing was accumulating.
    // The first call is progress (the transcript grew from empty), then
    // `maxStalled` unproductive sends are tolerated before the gate gives up.
    const flat = Array.from({ length: MAX_STALLED_AUTO_SENDS + 4 }, () => 14);
    const decisions = run(flat);
    const allowed = decisions.filter((d) => d.allow).length;
    expect(allowed).toBe(MAX_STALLED_AUTO_SENDS + 1);
    expect(decisions.at(-1)?.allow).toBe(false);
    expect(decisions.at(-1)?.stoppedLoop).toBe(true);
  });

  it("keeps refusing once it has given up", () => {
    const flat = Array.from({ length: MAX_STALLED_AUTO_SENDS + 5 }, () => 14);
    const decisions = run(flat);
    const refused = decisions.filter((d) => !d.allow);
    expect(refused).toHaveLength(4);
    // Every refusal reports the loop, so a caller that keeps asking cannot be
    // allowed back in by the same unproductive transcript.
    expect(refused.every((d) => d.stoppedLoop)).toBe(true);
  });

  it("recovers when real work arrives again", () => {
    const stalled = Array.from({ length: MAX_STALLED_AUTO_SENDS + 2 }, () => 14);
    const decisions = run([...stalled, 30, 32]);
    const afterGrowth = decisions.slice(-2);
    expect(afterGrowth.every((d) => d.allow)).toBe(true);
    expect(decisions.at(-1)?.state.stalled).toBe(0);
  });

  it("clears the streak on growth rather than carrying it forward", () => {
    // A burst of stalls, then progress, then a burst of stalls: the second burst
    // gets its own full budget instead of being cut short by the first.
    const first = Array.from({ length: MAX_STALLED_AUTO_SENDS + 1 }, () => 10);
    const second = Array.from({ length: MAX_STALLED_AUTO_SENDS + 1 }, () => 20);
    const decisions = run([...first, 20, ...second]);
    const [growth, ...burst] = decisions.slice(first.length);
    expect(growth.allow).toBe(true);
    expect(growth.state.stalled).toBe(0);
    // One tolerated send plus the full stalled budget for the new size.
    expect(burst.filter((d) => d.allow)).toHaveLength(MAX_STALLED_AUTO_SENDS);
    expect(burst.at(-1)?.allow).toBe(false);
  });

  it("honours a caller-supplied bound", () => {
    // With a bound of 1: one tolerated unproductive send, then refusals.
    const decisions = run([5, 5, 5, 5], 1);
    expect(decisions.map((d) => d.allow)).toEqual([true, true, false, false]);
  });

  it("starts from the initial state without allowing anything twice for free", () => {
    expect(INITIAL_AUTO_SEND_STATE).toEqual({ lastCount: 0, stalled: 0 });
    // The very first assessment is progress from an empty transcript.
    expect(autoSendGate(INITIAL_AUTO_SEND_STATE, 1).allow).toBe(true);
  });
});
