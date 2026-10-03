// The pure half of the pre-commit review: prompt shaping and the retry
// verdict. Kept free of tool/SDK wiring so the behavior is assertable without
// a provider key or a session shell.

export function buildReviewPrompt(diff: string, inspectHard: boolean): string {
  const core =
    'Review the following git diff for correctness bugs, security risks and architecture issues. Report only ACTIONABLE findings, each as "[MUST/SHOULD/NIT] - issue -> fix". If nothing is wrong say "Looks good."';
  // A reviewer that answers from the pasted text alone has read none of the
  // context the diff cannot show (callers, invariants the line touches). The
  // second attempt says so in as many words.
  const inspect = inspectHard
    ? " The previous pass made no tool calls, so its verdict counted for nothing: before the verdict you MUST open the changed files with read_file, and at least one caller or test where the diff changes a contract."
    : " The diff text alone hides context: open a changed file with read_file, and a caller or test where you need to judge behavior, before you verdict.";
  return `${core}${inspect}\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

type ReviewRun = (
  prompt: string,
  timeoutMs: number,
) => Promise<{ summary: string; inconclusive?: boolean }>;

/**
 * One review, then one retry when the first pass inspected nothing.
 *
 * `runSubagent` already files a 0-tool-call audit as `inconclusive`; the old
 * code returned that verdict anyway, so a reviewer that opened nothing could
 * approve a change set. Two empty passes are an error, not a "Looks good.".
 */
export async function reviewDiffWithRetry(
  diff: string,
  run: ReviewRun,
): Promise<{ summary: string; retried?: true } | { error: string }> {
  const first = await run(buildReviewPrompt(diff, false), 45_000);
  if (!first.inconclusive) return { summary: first.summary };
  const retry = await run(buildReviewPrompt(diff, true), 90_000);
  if (retry.inconclusive) {
    return {
      error:
        "code review inconclusive: the reviewer made no tool calls on either attempt, so any verdict is unsupported. Read the diff yourself (review_run) or narrow the scope and retry.",
    };
  }
  return { summary: retry.summary, retried: true };
}
