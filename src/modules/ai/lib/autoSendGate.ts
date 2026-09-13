// Loop breaker for the SDK's automatic approval resume.
//
// `Chat` re-sends by itself when the last assistant message carries answered
// approvals (`sendAutomaticallyWhen`). That is correct for one resume, and it is
// unbounded: nothing in the SDK counts how many times it has already done it. A
// model that re-requests the same approval every cycle therefore keeps the run
// alive forever, and the only existing guard (`approvalResumeFailureCount`)
// counts FAILED resumes, so a loop whose cycles all succeed is not bounded at
// all.
//
// Observed in the field: repeated `run: start (14 messages)` with
// `steps 1/25 | stop tool-calls` every few seconds. The message count never
// moved and `runRound` stayed 0, because an SDK auto-send does not go through
// the step-budget ladder - so the run was not making progress, it was repeating.
//
// The signal that separates the two is PROGRESS: a legitimate resume adds the
// tool result to the transcript, so the message count grows. A repeating cycle
// does not. This module keeps that decision pure so it can be tested.

/** Consecutive automatic sends that added nothing before the run is stopped. */
export const MAX_STALLED_AUTO_SENDS = 5;

export type AutoSendGateState = {
  /** Progress at the last allowed automatic send. */
  lastProgress: number;
  /** How many automatic sends in a row have added nothing. */
  stalled: number;
};

export const INITIAL_AUTO_SEND_STATE: AutoSendGateState = {
  lastProgress: 0,
  stalled: 0,
};

export type AutoSendDecision = {
  /** Whether the automatic send may proceed. */
  allow: boolean;
  /** State to keep for the next decision. */
  state: AutoSendGateState;
  /** True when this decision stopped a repeating run. */
  stoppedLoop: boolean;
};

/**
 * Decide whether an automatic resume may happen, given a progress measure and
 * how many consecutive resumes have already added nothing.
 *
 * `progress` must be something that changes whenever the transcript gains ANY
 * content. The number of messages is too coarse for that: a tool round appends
 * its results as parts of the SAME assistant message, so a run doing real work
 * can loop through many rounds with a constant message count. Measured in the
 * field: 19 consecutive runs, all `steps 1/25 | stop tool-calls`, while the UI
 * message count stayed at 14. Counting parts catches both that real work and the
 * spinning case, without stopping a legitimate tool loop after five rounds.
 */
export function autoSendGate(
  previous: AutoSendGateState,
  progress: number,
  maxStalled: number = MAX_STALLED_AUTO_SENDS,
): AutoSendDecision {
  // Progress since the last automatic send: the resume did something.
  if (progress > previous.lastProgress) {
    return {
      allow: true,
      state: { lastProgress: progress, stalled: 0 },
      stoppedLoop: false,
    };
  }

  const stalled = previous.stalled + 1;
  if (stalled > maxStalled) {
    // lastProgress is kept, so a later real message still resets the streak.
    return {
      allow: false,
      state: { lastProgress: previous.lastProgress, stalled },
      stoppedLoop: true,
    };
  }
  return {
    allow: true,
    state: { lastProgress: previous.lastProgress, stalled },
    stoppedLoop: false,
  };
}
