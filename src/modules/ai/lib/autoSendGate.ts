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
  /** Message count at the last allowed automatic send. */
  lastCount: number;
  /** How many automatic sends in a row have added nothing. */
  stalled: number;
};

export const INITIAL_AUTO_SEND_STATE: AutoSendGateState = {
  lastCount: 0,
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
 * Decide whether an automatic resume may happen, given the transcript size now
 * and how many consecutive resumes have already added nothing.
 *
 * `messageCount` is the whole transcript, so any real work - a tool result, a
 * new assistant message, a user correction - grows it and clears the streak.
 */
export function autoSendGate(
  previous: AutoSendGateState,
  messageCount: number,
  maxStalled: number = MAX_STALLED_AUTO_SENDS,
): AutoSendDecision {
  // Progress since the last automatic send: the resume did something.
  if (messageCount > previous.lastCount) {
    return {
      allow: true,
      state: { lastCount: messageCount, stalled: 0 },
      stoppedLoop: false,
    };
  }

  const stalled = previous.stalled + 1;
  if (stalled > maxStalled) {
    // lastCount is kept, so a later real message still resets the streak.
    return {
      allow: false,
      state: { lastCount: previous.lastCount, stalled },
      stoppedLoop: true,
    };
  }
  return {
    allow: true,
    state: { lastCount: previous.lastCount, stalled },
    stoppedLoop: false,
  };
}
