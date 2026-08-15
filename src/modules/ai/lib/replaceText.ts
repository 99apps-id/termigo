// Literal cross-file replacement.
//
// Search is a literal string, not a regex, and that is the whole design. A
// regex spanning a whole repository is one bad character away from rewriting
// files nobody looked at, and the common case - rename this symbol, update this
// URL - needs no pattern language. The grep backend takes a regex, so the
// literal is escaped on the way in rather than exposed.

/** How many files one call may touch before it refuses and asks to narrow. */
export const MAX_REPLACE_FILES = 50;

/** Escape a literal so the regex-based grep matches it verbatim. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every occurrence, reporting how many there were.
 *
 * The count is what makes the result checkable: "changed 3 files" without it
 * says nothing about whether the change was the one intended.
 */
export function replaceAllCount(
  content: string,
  search: string,
  replacement: string,
): { content: string; count: number } {
  if (!search) return { content, count: 0 };
  let count = 0;
  let out = "";
  let from = 0;
  for (;;) {
    const at = content.indexOf(search, from);
    if (at === -1) break;
    out += content.slice(from, at) + replacement;
    from = at + search.length;
    count++;
  }
  if (count === 0) return { content, count: 0 };
  return { content: out + content.slice(from), count };
}

/**
 * Whether a replacement would loop back on itself.
 *
 * Not a real risk for `replaceAllCount`, which walks forward past each match,
 * but a replacement containing the search text means running the tool twice
 * keeps growing the file. Worth telling the model rather than letting it
 * discover the mess.
 */
export function isSelfReferential(search: string, replacement: string): boolean {
  return search.length > 0 && replacement.includes(search);
}

/** Unique file paths from grep hits, in first-seen order. */
export function uniquePaths(hits: readonly { path: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    out.push(h.path);
  }
  return out;
}
