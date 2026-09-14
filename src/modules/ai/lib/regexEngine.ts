// Making the search engine's limits legible, before and after a rejected pattern.
//
// `grep` runs ripgrep's regex engine (the `regex` crate, RE2 syntax). It has no
// look-around and no backreferences - a deliberate trade for linear-time
// matching. Models habitually write PCRE patterns anyway, and one did:
//
//   bad regex: regex parse error:
//       (?:parseInt\((?!\s*[A-Za-z_$][\w.$]*\s*,))
//                    ^^^
//   error: look-around, including look-ahead and look-behind, is not supported
//
// The engine's message is accurate but it does not say what to do instead, so
// the model's next move is usually another guess. Naming the construct and the
// replacement costs nothing and saves the round trip.
//
// The hint is also stated up front in the tool's own description, because a
// limit the model knows about is a limit it does not test.

/** Named up front in the tool description, so most patterns never fail. */
export const SEARCH_PATTERN_HINT =
  "RE2/ripgrep syntax: no look-around ((?=) (?!) (?<=) (?<!)) and no " +
  "backreferences (\\1). Every match is confined to ONE line, so a pattern " +
  "cannot span a newline. Alternation (a|b), anchoring (^ $ \\b), character " +
  "classes and {n,m} repeats all work.";

type EngineLimit = {
  /** Substring of the engine's message that identifies this limit. */
  match: string;
  /** What the model should do instead. */
  advice: string;
};

const LIMITS: readonly EngineLimit[] = [
  {
    match: "look-around",
    advice:
      "This engine has no look-around. Rewrite without it: match the broader " +
      "pattern and read the hits, or use a second grep to subtract what you " +
      "do not want. For 'X not followed by Y', matching X and then checking " +
      "the hits is usually enough.",
  },
  {
    match: "backreference",
    advice:
      "This engine has no backreferences (\\1). Match the repeated part " +
      "explicitly, or grep the general shape and narrow by reading the hits.",
  },
  {
    match: "repetition operator missing",
    advice:
      "A repetition operator (* + ? {n}) has nothing before it. Escape the " +
      "literal character (\\* for a literal asterisk) or add the atom it " +
      "should repeat.",
  },
  {
    match: "unclosed group",
    advice: "A group is missing its closing ) - or use \\( to match a literal parenthesis.",
  },
  {
    match: "unclosed character class",
    advice:
      "A character class is missing its closing ] - or use \\[ to match a literal bracket.",
  },
  {
    match: "repetition quantifier expects a valid decimal",
    advice: "A {n,m} repeat has a malformed number inside the braces.",
  },
  {
    // The engine's own text is `the literal "\n" is not allowed in a regex`,
    // so the marker has to carry the escaped form, not a real newline.
    match: 'the literal "\\n" is not allowed',
    // The example names the code rather than embedding an escaped pattern:
    // writing `\\.then\\(` in a string literal is easy to over-escape, and the
    // model knows which characters in `.then(` need escaping.
    advice:
      "grep reads the workspace one line at a time, so a pattern cannot cross " +
      "a newline - and there is no multiline mode to switch on, despite what " +
      "the engine's own hint suggests. Match the part that lives on one line, " +
      "such as the `.then(` call, and read the lines around each hit; or run " +
      "one grep per line and compare where the results meet.",
  },
];

/**
 * Turn an engine rejection into something the model can act on.
 *
 * A known limit gets its own rewrite and NOTHING else: naming the whole dialect
 * as well would bury the relevant sentence under advice about constructs that
 * are not the problem, which is how a newline error ends up being answered with
 * a lecture about look-around. An unrecognised error is passed through with the
 * dialect note rather than swallowed - the engine's own message (with its caret
 * pointing at the offending column) is the best clue available for a shape not
 * covered here.
 */
export function explainSearchEngineError(rawError: string): string {
  const raw = String(rawError ?? "").trim();
  if (!raw) return `pattern rejected by the search engine (${SEARCH_PATTERN_HINT})`;
  const limit = LIMITS.find((l) => raw.includes(l.match));
  if (limit) return `${raw}\n${limit.advice}`;
  return `${raw}\nNote: ${SEARCH_PATTERN_HINT}`;
}
