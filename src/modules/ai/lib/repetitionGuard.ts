/**
 * Cheap content-sanity check for a model stuck in a repetition loop.
 *
 * Ported from Hermes' `repetition_guard.py`. A degenerate model can spend an
 * entire output budget echoing one fragment. Termigo has no `finish_reason =
 * length` continuation nudge (the shape Hermes guarded), but the same loop
 * shows up at step boundaries: a step whose text is mostly one repeated
 * window. Detecting it lets the run stop with a clear reason instead of
 * burning more steps (and tokens) on noise.
 *
 * Deliberately conservative: only LONG verbatim repeats (60+ chars) covering a
 * majority of the fragment trip it. Ordinary reuse — citations, headings,
 * similar code blocks, a table with repeated separators — never reaches the
 * threshold.
 */

/** Below this length the check doesn't run: short text trivially contains
 *  repeated tokens and is legitimately kept. */
export const MIN_FRAGMENT_LENGTH = 400;
/** Exact-repeat window; far beyond ordinary phrasing reuse. */
export const REPEAT_WINDOW = 60;
/** A window repeating at least this often is a signal even for short fragments. */
export const MIN_REPEAT_COUNT = 5;
/** "Repetition-dominated" = repeated windows cover at least this fraction. */
export const DOMINANCE_RATIO = 0.5;

/**
 * True when a single 60+ char substring recurs often enough to cover at least
 * half of `text` — the signature of a repetition loop. Fail-open for
 * non-string/short input.
 */
export function isRepetitionDominated(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const n = text.length;
  if (n < MIN_FRAGMENT_LENGTH) return false;

  // Fast path: one normalized line duplicated enough to cover half the
  // fragment (the common echo shape).
  if (lineRepetitionDominated(text, n)) return true;

  // General path: fixed-size windows sliding one char at a time, catching
  // loops that don't align to line boundaries. A window must appear `needed`
  // times to cover >= DOMINANCE_RATIO (and >= MIN_REPEAT_COUNT).
  const window = REPEAT_WINDOW;
  const needed = Math.max(
    MIN_REPEAT_COUNT,
    Math.ceil((n * DOMINANCE_RATIO) / window),
  );
  const counts = new Map<string, number>();
  for (let i = 0; i <= n - window; i++) {
    const key = text.slice(i, i + window);
    const c = (counts.get(key) ?? 0) + 1;
    if (c >= needed) return true;
    counts.set(key, c);
  }
  return false;
}

/** True when a single normalized line covers half the fragment via repeats. */
function lineRepetitionDominated(text: string, n: number): boolean {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const norm = raw.trim();
    if (!norm) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  for (const [line, c] of counts) {
    if (c >= MIN_REPEAT_COUNT && c * line.length >= n * DOMINANCE_RATIO) {
      return true;
    }
  }
  return false;
}
