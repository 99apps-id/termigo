// Live syntax highlighting for the composer, ported from Hermes'
// composerHighlights.ts and adapted to Termigo's reference vocabulary:
// `/command` (built-in or user-defined), `#snippet` handles, and `@file`
// refs — the same three tokens the picker popovers trigger on, so what the
// picker accepts is what lights up.
//
// Concatenating every `text` reproduces the input exactly — styling only, the
// text is never rewritten. Regexes are built per call: a shared `/g` instance
// carries `lastIndex` between callers and silently skips the first match in
// the next string it is handed.

export type ComposerHighlight = { ref: boolean; text: string };

export type HighlightVocab = {
  /** Known slash-command names (no leading `/`). */
  commands: ReadonlySet<string>;
  /** Known snippet handles (no leading `#`). */
  snippets: ReadonlySet<string>;
};

type Span = { start: number; end: number };

// A trigger token: `/`, `#` or `@` at the start of input or after whitespace,
// followed by the typed word (possibly empty — the user just pressed the key).
// Paths like `/usr/local` or `a/b` never match: the lookbehind requires a
// boundary and the token stops at the first non-word character.
const tokenRe = () => /(?<=^|\s)([/#@])([\w-]*)/g;

const matchSpans = (text: string, vocab: HighlightVocab): Span[] => {
  const spans: Span[] = [];
  for (const m of text.matchAll(tokenRe())) {
    const kind = m[1];
    const word = m[2] ?? "";
    const start = m.index ?? 0;
    // `@file` refs light up as soon as the `@` is typed: any token is a
    // candidate path and the picker is already open on it.
    if (kind === "@") {
      spans.push({ start, end: start + m[0].length });
      continue;
    }
    const known = kind === "/" ? vocab.commands : vocab.snippets;
    // A completed name lights up; so does a prefix of one — that is the user
    // mid-typing with the picker open, and the highlight is the feedback that
    // the token is being recognised. An unknown full word stays plain prose.
    const lit =
      word.length > 0 &&
      (known.has(word.toLowerCase()) ||
        [...known].some((k) => k.startsWith(word.toLowerCase())));
    if (lit) spans.push({ start, end: start + m[0].length });
  }
  return spans;
};

/**
 * Split composer text into plain and reference spans. The spans are ordered
 * and non-overlapping, and their concatenation is exactly `text`.
 */
export function splitComposerHighlights(
  text: string,
  vocab: HighlightVocab,
): ComposerHighlight[] {
  const spans = matchSpans(text, vocab)
    .sort((a, b) => a.start - b.start)
    .reduce<Span[]>((kept, span) => {
      if (!kept.some((prev) => span.start < prev.end && span.end > prev.start)) {
        kept.push(span);
      }
      return kept;
    }, []);

  const out: ComposerHighlight[] = [];
  let last = 0;
  for (const span of spans) {
    if (span.start > last) {
      out.push({ ref: false, text: text.slice(last, span.start) });
    }
    out.push({ ref: true, text: text.slice(span.start, span.end) });
    last = span.end;
  }
  if (last < text.length || out.length === 0) {
    out.push({ ref: false, text: text.slice(last) });
  }
  return out;
}
