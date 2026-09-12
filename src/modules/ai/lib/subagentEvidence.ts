// Whether a sub-agent audit actually looked at anything.
//
// A sub-agent that abandons its task still returns prose, and the harness had no
// way to tell that prose from a completed review. Three of four audits in one
// batch came back like this, and the store recorded every one as `done`:
//
//   "No actionable findings could be confirmed from this review - but that is a
//    statement about the evidence, not a clean bill of health..."
//   "Every body I was able to obtain consisted only of the import preamble and
//    top-of-file declarations."
//
// The claims were false. The tool layer had returned the full files: the same
// session's transcript shows `read_file` on `pty/session.rs` - a 409-line,
// 14.8 KB file the audit said it could not read - returning 16.7 KB of content.
// Another audit said a `glob` result was "cut off mid-array ... no closing
// brackets", which cannot happen: a tool result is an object, not JSON text.
//
// So the useful signal is not "did it fail" (it did not) but "did it say it
// could not do the work". That is a narrow, checkable claim, and a caller that
// sees it can re-run the audit instead of filing a clean result it never got.
// Deliberately conservative: only an explicit statement that the review was
// incomplete trips it, never a mere caveat or a finding phrased as "could not
// reproduce X".

export type SubagentEvidence = {
  /** Steps the sub-agent ran. */
  steps: number;
  /** Tool calls it made across those steps. */
  toolCalls: number;
};

/**
 * Phrases in which an audit declares its own incompleteness.
 *
 * Each is about the REVIEW not happening, not about a bug not reproducing -
 * "could not reproduce the crash" is a finding and must not match.
 */
const INCOMPLETE_MARKERS: readonly string[] = [
  "could not complete",
  "could not be confirmed",
  "could not obtain",
  "truncated preambles",
  // The verbatim phrasing from the audit that produced this: "Every body I was
  // able to obtain consisted only of the import preamble and top-of-file
  // declarations." First written as "only the import preamble", which does not
  // occur in the sentence and made the detector miss its own source case.
  "of the import preamble",
  "did not get the contents",
  "no actionable findings",
];

/** An audit that ran no tool calls inspected nothing, whatever it concluded. */
const MIN_TOOL_CALLS_FOR_AN_AUDIT = 2;

/** True when `summary` states the review itself was incomplete. */
export function declaresIncomplete(summary: string): boolean {
  const text = String(summary ?? "").toLowerCase();
  if (!text) return false;
  return INCOMPLETE_MARKERS.some((m) => text.includes(m));
}

export type EvidenceVerdict = {
  /** The result must not be read as a completed audit. */
  inconclusive: boolean;
  /** One line to append to the summary, or null when nothing is wrong. */
  note: string | null;
};

/**
 * Judge a finished sub-agent run.
 *
 * `taskKind` is the caller's own classification; only work whose value depends
 * on having inspected the repository can be inconclusive, so a sub-agent that
 * was asked to write a file is not judged by whether it read much.
 */
export function judgeSubagentEvidence(
  summary: string,
  evidence: SubagentEvidence,
  opts: { audit: boolean },
): EvidenceVerdict {
  if (!opts.audit) return { inconclusive: false, note: null };

  const claimedNone = declaresIncomplete(summary);
  const inspectedNothing = evidence.toolCalls < MIN_TOOL_CALLS_FOR_AN_AUDIT;

  if (claimedNone) {
    return {
      inconclusive: true,
      note:
        "[inconclusive] This sub-agent reports that its review was " +
        "incomplete. Treat the above as unverified: do NOT report it as a " +
        "clean audit. Re-run it with a narrower scope, or do that part of the " +
        "review yourself with `read_file`/`grep`.",
    };
  }
  if (inspectedNothing) {
    return {
      inconclusive: true,
      note:
        `[inconclusive] This sub-agent ran ${evidence.toolCalls} tool call(s) ` +
        `across ${evidence.steps} step(s), so it inspected nothing. Any ` +
        "conclusion above is unsupported - re-run it or do the review yourself.",
    };
  }
  return { inconclusive: false, note: null };
}
