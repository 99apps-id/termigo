// Matching a tool name a model asked for against the tools that exist.
//
// Two callers need this and must agree:
//
// - `lib/repairToolCall.ts` rewrites a near-miss to the real name BEFORE the
//   call runs, so a recoverable typo executes instead of failing.
// - `tools/toolFallback.ts` answers a name that could not be rewritten, telling
//   the model what does exist and what it probably meant.
//
// They shared a private copy of the edit-distance matcher before this module,
// which is the shape that drifts: a threshold tuned in one place silently stops
// applying in the other.

/**
 * Levenshtein distance. Iterative with two rows: the names here are short, but
 * this runs over every available tool for every unknown call, so the allocation
 * count matters more than the asymptotics.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Find the available tool name closest to `requested`.
 *
 * Accepts the match only when the distance is small relative to the name
 * length, so a near-miss typo is fixed without ever rewriting one real tool
 * name into a different real tool: `read_file` must not become `write_file`.
 */
export function bestToolMatch(
  requested: string,
  available: readonly string[],
): string | null {
  let best = "";
  let bestDistance = Infinity;
  for (const name of available) {
    const d = editDistance(requested, name);
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  if (best === "") return null;
  const longer = Math.max(requested.length, best.length);
  // Allow a couple of edits, growing with the name length, but never enough to
  // turn one genuinely different, similarly-named tool into another.
  const threshold = Math.max(2, Math.round(longer * 0.12));
  return bestDistance <= threshold ? best : null;
}

/**
 * Rank several candidates for "did you mean", best first.
 *
 * Deliberately looser than `bestToolMatch`: this only ever produces advice in a
 * message, never a rewrite, so a suggestion that is close-ish is useful while a
 * rewrite that is close-ish is dangerous. Accepts a shared word (`browser` ->
 * `browser_click`) as well as a small edit distance.
 */
export function suggestToolNames(
  requested: string,
  available: readonly string[],
  limit = 5,
): string[] {
  const target = requested.trim().toLowerCase();
  if (!target) return [];
  const targetWords = new Set(target.split(/[^a-z0-9]+/).filter(Boolean));

  const scored: { name: string; score: number }[] = [];
  for (const name of available) {
    const candidate = name.toLowerCase();
    if (candidate === target) continue;

    let score = 0;
    if (candidate.startsWith(target) || target.startsWith(candidate)) {
      score += 40;
    }
    const words = candidate.split(/[^a-z0-9]+/).filter(Boolean);
    for (const word of words) {
      if (targetWords.has(word)) score += 25;
      else if (word.length > 3 && target.includes(word)) score += 10;
      else if (word.length > 3 && word.includes(target)) score += 8;
    }
    const distance = editDistance(target, candidate);
    const longer = Math.max(target.length, candidate.length) || 1;
    if (distance / longer <= 0.35) {
      score += Math.round((1 - distance / longer) * 30);
    }
    if (score > 0) scored.push({ name, score });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(0, limit)).map((s) => s.name);
}
