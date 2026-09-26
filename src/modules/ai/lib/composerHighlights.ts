// Live syntax highlighting for the composer, adapted to Termigo's reference vocabulary:
// `/command` (built-in or user-defined), `#snippet` handles, and `@file`
// refs — the same three tokens the picker popovers trigger on, so what the
// picker accepts is what lights up.
//
// Concatenating every `text` reproduces the input exactly — styling only, the
// text is never rewritten. Regexes are built per call: a shared `/g` instance
// carries `lastIndex` between callers and silently skips the first match in
// the next string it is handed.

export type ComposerHighlight = {
  ref: boolean;
  text: string;
  /** Offset of the span in the source string — a stable identity for keys. */
  start: number;
};

export type HighlightVocab = {
  /** Known slash-command names (no leading `/`). */
  commands: ReadonlySet<string>;
  /** Known snippet handles (no leading `#`). */
  snippets: ReadonlySet<string>;
};

type Span = { start: number; end: number };

// A `/command` or `#snippet` trigger: at the start of input or after
// whitespace, followed by the typed word (possibly empty — the user just
// pressed the key). Paths like `/usr/local` or `a/b` never match: the boundary
// group is required and the token stops at the first non-word character.
//
// The boundary is a consuming group rather than a lookbehind. Lookbehind is
// ES2018 and is missing from older WebKitGTK builds, where the regex LITERAL is
// a parse-time SyntaxError - the module would fail to load, taking the whole
// bundle with it, instead of merely highlighting nothing. The group is captured
// and subtracted from the match index below, so the spans are identical.
const wordTokenRe = () => /(^|\s)([/#])([\w-]*)/g;

// An `@file` ref runs to the next whitespace — paths contain `/` and `.`, and
// the file picker's own trigger detection scans back to whitespace, so the
// highlight must cover the same span the picker would.
const atTokenRe = () => /(^|\s)@(\S*)/g;

/** Where a match really starts, excluding the captured boundary character. */
const boundaryOffset = (lead: string | undefined): number => lead?.length ?? 0;

const matchSpans = (text: string, vocab: HighlightVocab): Span[] => {
  const spans: Span[] = [];
  for (const m of text.matchAll(atTokenRe())) {
    // `@file` refs light up as soon as the `@` is typed: any token is a
    // candidate path and the picker is already open on it.
    const start = (m.index ?? 0) + boundaryOffset(m[1]);
    spans.push({ start, end: start + 1 + (m[2] ?? "").length });
  }
  for (const m of text.matchAll(wordTokenRe())) {
    const kind = m[2];
    const word = m[3] ?? "";
    const start = (m.index ?? 0) + boundaryOffset(m[1]);
    const known = kind === "/" ? vocab.commands : vocab.snippets;
    // A completed name lights up; so does a prefix of one — that is the user
    // mid-typing with the picker open, and the highlight is the feedback that
    // the token is being recognised. An unknown full word stays plain prose.
    const lit =
      word.length > 0 &&
      (known.has(word.toLowerCase()) ||
        [...known].some((k) => k.startsWith(word.toLowerCase())));
    if (lit) spans.push({ start, end: start + 1 + word.length });
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
      out.push({ ref: false, text: text.slice(last, span.start), start: last });
    }
    out.push({
      ref: true,
      text: text.slice(span.start, span.end),
      start: span.start,
    });
    last = span.end;
  }
  if (last < text.length || out.length === 0) {
    out.push({ ref: false, text: text.slice(last), start: last });
  }
  return out;
}
