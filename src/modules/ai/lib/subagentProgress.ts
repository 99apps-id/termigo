// Whether a sub-agent run did anything observable.
//
// Smaller / routed OpenAI-compatible models intermittently return an EMPTY
// completion: no text and no tool call, finishing in a few seconds with
// `steps: [one empty step]`. That is a provider/model failure, not a result.
// Reporting it as "(no output)" let the orchestrator read a failed task as
// "ran, found nothing" and move on; this predicate is the shared check that
// turns it into a visible error instead.

export type SubagentRunLike = {
  steps?: Array<{ toolCalls?: unknown[]; toolResults?: unknown[] }>;
};

export function subagentMadeProgress(run: SubagentRunLike): boolean {
  return (run.steps ?? []).some(
    (s) => (s.toolCalls?.length ?? 0) > 0 || (s.toolResults?.length ?? 0) > 0,
  );
}
