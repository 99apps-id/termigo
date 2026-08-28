// Learn a model's REAL context window from the provider's own overflow error,
// and shrink compaction aggressively enough that the retry fits.
//
// Two things go wrong that a static configured limit cannot catch:
//   1. The configured limit is simply too high (a model listed at 1M that the
//      provider actually caps at 262144).
//   2. Our token ESTIMATE (chars/3.5) runs low on dense or CJK content, so
//      compaction stops trimming while the real request is still far over.
//
// The provider error carries the ground truth — "maximum context length is N
// tokens. However, you requested M tokens" — which gives both the real cap (N)
// and how badly we overshot (M/N). We record N, and set a budget SCALE from the
// overshoot so the next attempt lands under the cap in a single retry, then let
// a comfortably-fitting request relax the scale back toward 1.

type ModelId = string;

const realLimit = new Map<ModelId, number>();
/** Budget multiplier in (0,1]. 1 = trust the configured/real limit as-is. */
const budgetScale = new Map<ModelId, number>();

const MIN_SCALE = 0.12;
const SAFETY = 0.85;

/** Parse "maximum context length is N tokens ... requested M tokens" from a
 *  provider error. Either field may be absent. */
export function parseContextOverflow(message: string): {
  max: number | null;
  requested: number | null;
} {
  const max = /maximum context length is\s*(\d[\d,]*)\s*tokens/i.exec(message);
  const req = /requested\s*(\d[\d,]*)\s*tokens/i.exec(message);
  const num = (m: RegExpExecArray | null) =>
    m ? Number.parseInt(m[1].replace(/,/g, ""), 10) : null;
  return { max: num(max), requested: num(req) };
}

/** Whether an error message is a context-window overflow. */
export function isContextOverflowError(message: string): boolean {
  const l = message.toLowerCase();
  return (
    l.includes("maximum context length") ||
    l.includes("context_length_exceeded") ||
    (l.includes("context length") && l.includes("token"))
  );
}

/** Record an overflow so the next request for this model compacts to fit. */
export function recordContextOverflow(modelId: string, message: string): void {
  if (!modelId) return;
  const { max, requested } = parseContextOverflow(message);
  if (max && max > 0) realLimit.set(modelId, max);
  if (max && requested && requested > max) {
    // Aim the next request at ~85% of the cap, scaled by the overshoot: if we
    // sent M for a cap of N, target (N/M) of the budget so the retry lands near
    // N, then trim a further 15% for safety and estimate error.
    const target = (max / requested) * SAFETY;
    const prev = budgetScale.get(modelId) ?? 1;
    budgetScale.set(modelId, Math.max(MIN_SCALE, Math.min(prev, target)));
  } else {
    // Overflow with no numbers: just tighten a notch.
    const prev = budgetScale.get(modelId) ?? 1;
    budgetScale.set(modelId, Math.max(MIN_SCALE, prev * 0.7));
  }
}

/**
 * The limit compaction should actually target: the smaller of the configured
 * limit and any real cap learned from the provider, times the current scale.
 */
export function effectiveContextLimit(
  modelId: string,
  configured: number,
): number {
  const real = realLimit.get(modelId);
  const base = real ? Math.min(configured, real) : configured;
  const scale = budgetScale.get(modelId) ?? 1;
  return Math.max(Math.floor(base * scale), 8_000);
}

/**
 * After a request SUCCEEDS, feed back its real input-token count so the scale
 * can relax once the conversation is small again — otherwise a single overflow
 * would over-compact the model forever.
 */
export function noteSuccessfulRequest(
  modelId: string,
  realInputTokens: number,
): void {
  const scale = budgetScale.get(modelId);
  if (!scale || scale >= 1) return;
  const real = realLimit.get(modelId);
  if (!real) return;
  // Plenty of headroom used → we over-tightened; ease the scale back up.
  if (realInputTokens > 0 && realInputTokens < 0.45 * real) {
    budgetScale.set(modelId, Math.min(1, scale * 1.4));
  }
}

/** Test/reset hook. */
export function resetContextLearning(): void {
  realLimit.clear();
  budgetScale.clear();
}
