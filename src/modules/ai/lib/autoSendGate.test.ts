// The loop breaker for the SDK's automatic approval resume.
//
// The failure this guards against is an endless cycle, not a crash: the model
// re-requests the same approval, the SDK re-sends automatically, the transcript
// never grows, and the run repeats forever. The distinguishing signal is
// progress, so the cases below are about which counts count as progress.

import { describe, expect, it } from "vitest";
import {
  autoSendAskIsDuplicate,
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
    const stalled = Array.from(
      { length: MAX_STALLED_AUTO_SENDS + 2 },
      () => 14,
    );
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
    expect(INITIAL_AUTO_SEND_STATE).toEqual({ lastProgress: 0, stalled: 0 });
    // The very first assessment is progress from an empty transcript.
    expect(autoSendGate(INITIAL_AUTO_SEND_STATE, 1).allow).toBe(true);
  });

  it("treats growth in parts as progress, not just growth in message count", () => {
    // Why the caller counts PARTS. A tool round appends its results to the same
    // assistant message, so real work can add many parts while the number of
    // messages stays constant. Measuring messages would call that a stall and
    // stop a run that was making progress - the field log showed exactly that
    // shape: 19 runs, `steps 1/25 | stop tool-calls`, message count pinned at 14
    // while the transcript was in fact changing.
    const decisions = run([10, 14, 18, 22, 26, 30, 34]);
    expect(decisions.every((d) => d.allow)).toBe(true);
    // Each growth step also clears the stall streak.
    expect(decisions.at(-1)?.state.stalled).toBe(0);
  });

  it("stops a tool-error loop where parts grow but the signature repeats", () => {
    let state = INITIAL_AUTO_SEND_STATE;
    const decisions: ReturnType<typeof autoSendGate>[] = [];
    const sameSignature = "bash_run:cat missing:err:file not found";

    // 6 consecutive auto-sends where transcript grows (+2 parts each time)
    // but the exact same failing tool call repeats
    for (let i = 0; i < MAX_STALLED_AUTO_SENDS + 2; i++) {
      const decision = autoSendGate(state, 10 + i * 2, MAX_STALLED_AUTO_SENDS, sameSignature);
      state = decision.state;
      decisions.push(decision);
    }

    // First call is allowed as initial progress
    expect(decisions[0].allow).toBe(true);
    expect(decisions[0].state.stalled).toBe(0);

    // Subsequent repeating signatures increment stalled
    expect(decisions[1].state.stalled).toBe(1);
    expect(decisions[MAX_STALLED_AUTO_SENDS].state.stalled).toBe(MAX_STALLED_AUTO_SENDS);

    // After MAX_STALLED_AUTO_SENDS, loop is stopped
    const last = decisions.at(-1)!;
    expect(last.allow).toBe(false);
    expect(last.stoppedLoop).toBe(true);
  });

  it("resets stalled counter when a different tool signature arrives", () => {
    let state = INITIAL_AUTO_SEND_STATE;
    state = autoSendGate(state, 10, 5, "read:a.ts:data").state;
    state = autoSendGate(state, 12, 5, "read:a.ts:data").state;
    expect(state.stalled).toBe(1);

    // Different tool call arrives
    const third = autoSendGate(state, 14, 5, "read:b.ts:data");
    expect(third.allow).toBe(true);
    expect(third.state.stalled).toBe(0);
  });
});

/**
 * The gate is only as good as what the caller feeds it, and the first version
 * of that caller fed it nothing in the case that matters. These tests drive the
 * gate the way the runtime does, including the duplicate asks inside one cycle.
 */
describe("the caller's once-per-send rule", () => {
  /** Mirrors `sendAutomaticallyWhen`: asks are deduped, a round clears pending. */
  function simulate(progressPerCycle: number[]): boolean[] {
    let state = INITIAL_AUTO_SEND_STATE;
    let decidedAt = -1;
    let allowed = true;
    let pending = false;
    const perCycle: boolean[] = [];
    for (const progress of progressPerCycle) {
      let verdict = false;
      // The SDK may ask more than once before the round starts.
      for (let ask = 0; ask < 2; ask += 1) {
        if (autoSendAskIsDuplicate({ pending, decidedAt, progress })) {
          verdict = allowed;
          continue;
        }
        const decision = autoSendGate(state, progress);
        state = decision.state;
        decidedAt = progress;
        allowed = decision.allow;
        pending = decision.allow;
        verdict = allowed;
      }
      perCycle.push(verdict);
      // The authorised send became a round (`onRoundStart`).
      pending = false;
    }
    return perCycle;
  }

  it("counts one stalled resume per real send, not one per ask", () => {
    // THE regression, 2026-09-15. Fifteen resumes, ~3 minutes apart, all
    // aborted: the transcript stayed at the same part count because a killed
    // resume appends nothing. The old rule returned the cached verdict for an
    // unchanged progress value, so `stalled` never incremented and the bound
    // never engaged - the run repeated for half an hour with the app looking
    // frozen. The first cycle is progress (from an empty transcript), then
    // `MAX_STALLED_AUTO_SENDS` unproductive resumes are tolerated.
    const cycles = MAX_STALLED_AUTO_SENDS + 3;
    const verdicts = simulate(Array.from({ length: cycles }, () => 170));
    expect(verdicts.filter(Boolean)).toHaveLength(MAX_STALLED_AUTO_SENDS + 1);
    expect(verdicts.at(-1)).toBe(false);
  });

  it("still allows every cycle that grows the transcript", () => {
    const verdicts = simulate([10, 14, 18, 22, 26, 30, 34]);
    expect(verdicts.every(Boolean)).toBe(true);
  });

  it("only treats a repeated ask as duplicate once a send is pending", () => {
    // Without the pending flag the same progress would be free forever, which is
    // the bug this replaced; with it, the second ask of the SAME cycle is free
    // and the next cycle is counted.
    expect(
      autoSendAskIsDuplicate({ pending: true, decidedAt: 170, progress: 170 }),
    ).toBe(true);
    expect(
      autoSendAskIsDuplicate({ pending: false, decidedAt: 170, progress: 170 }),
    ).toBe(false);
    expect(
      autoSendAskIsDuplicate({ pending: true, decidedAt: 170, progress: 174 }),
    ).toBe(false);
  });
});
