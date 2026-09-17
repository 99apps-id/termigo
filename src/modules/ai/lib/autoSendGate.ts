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
  /** Latest tool call or error signature seen. */
  lastSignature?: string | null;
  /** Sliding window of recent tool signatures seen in this session. */
  recentSignatures?: string[];
};

export const INITIAL_AUTO_SEND_STATE: AutoSendGateState = {
  lastProgress: 0,
  stalled: 0,
  recentSignatures: [],
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
 * Decide whether an automatic resume may happen, given a progress measure,
 * how many consecutive resumes have already added nothing, and an optional
 * signature of the latest tool call / result.
 *
 * `progress` must be something that changes whenever the transcript gains ANY
 * content. The number of messages is too coarse for that: a tool round appends
 * its results as parts of the SAME assistant message, so a run doing real work
 * can loop through many rounds with a constant message count.
 *
 * When `signature` is provided, repeating the exact same tool call/error signature
 * across resumes is treated as a stall even if part counts grew, breaking
 * infinite repeating tool loops.
 */
export const SIGNATURE_WINDOW_SIZE = 8;

export function isRepetitiveSignature(
  history: readonly string[],
  current: string | null | undefined,
): boolean {
  if (!current) return false;
  const len = history.length;
  if (len === 0) return false;

  // 1. Direct immediate repetition: A -> A
  if (history[len - 1] === current) return true;

  // 2. Frequency threshold: already appears >= 2 times in recent window (current makes 3)
  const count = history.filter((s) => s === current).length;
  if (count >= 2) return true;

  // 3. Period-2 oscillation: [..., A, B, A] + current B -> A-B-A-B
  if (len >= 3) {
    if (history[len - 1] === history[len - 3] && history[len - 2] === current) {
      return true;
    }
  }

  // 4. Period-3 cycle: [..., A, B, C, A, B] + current C -> A-B-C-A-B-C
  if (len >= 5) {
    if (
      history[len - 1] === history[len - 4] &&
      history[len - 2] === history[len - 5] &&
      history[len - 3] === current
    ) {
      return true;
    }
  }

  return false;
}

export function autoSendGate(
  previous: AutoSendGateState,
  progress: number,
  maxStalled: number = MAX_STALLED_AUTO_SENDS,
  signature?: string | null,
): AutoSendDecision {
  const history =
    previous.recentSignatures ??
    (previous.lastSignature ? [previous.lastSignature] : []);
  const isRepeatingSignature = isRepetitiveSignature(history, signature);

  const updatedHistory = signature
    ? [...history.slice(-(SIGNATURE_WINDOW_SIZE - 1)), signature]
    : history;

  // Real progress: transcript grew AND it is not an identical or cyclic repeating signature.
  if (progress > previous.lastProgress && !isRepeatingSignature) {
    return {
      allow: true,
      state: {
        lastProgress: progress,
        stalled: 0,
        lastSignature: signature ?? null,
        recentSignatures: updatedHistory,
      },
      stoppedLoop: false,
    };
  }

  const stalled = previous.stalled + 1;
  if (stalled > maxStalled) {
    // lastProgress is kept, so a later real message still resets the streak.
    return {
      allow: false,
      state: {
        lastProgress: previous.lastProgress,
        stalled,
        lastSignature: signature ?? previous.lastSignature ?? null,
        recentSignatures: updatedHistory,
      },
      stoppedLoop: true,
    };
  }
  return {
    allow: true,
    state: {
      lastProgress: previous.lastProgress,
      stalled,
      lastSignature: signature ?? previous.lastSignature ?? null,
      recentSignatures: updatedHistory,
    },
    stoppedLoop: false,
  };
}

/**
 * Whether this ask is the same authorised send being asked about again.
 *
 * The SDK may call the predicate more than once inside one cycle, and counting
 * each ask would tighten the bound silently - but the first fix for that cached
 * the verdict by PROGRESS VALUE, and that is what made this gate inert in the
 * one case it exists for:
 *
 *     if (progress === autoSendDecidedAt) return autoSendAllowed;   // bug
 *
 * An aborted resume adds nothing to the transcript, so `progress` is unchanged,
 * the cached `true` is returned, and `autoSendGate` is never called - the
 * `stalled` counter cannot move exactly when a run is repeating without
 * progress. Observed in the field as fifteen consecutive aborted resumes, one
 * every ~3 minutes, with the transcript frozen.
 *
 * So the duplicate question is "has the send I authorised actually started?"
 * rather than "has the progress value changed?". The caller clears `pending`
 * when a round really begins, which makes one cycle equal one count.
 */
export function autoSendAskIsDuplicate(input: {
  /** An authorised automatic send that has not become a round yet. */
  pending: boolean;
  /** The progress value the last decision was made at. */
  decidedAt: number;
  /** Progress of the transcript being asked about. */
  progress: number;
}): boolean {
  return input.pending && input.progress === input.decidedAt;
}
