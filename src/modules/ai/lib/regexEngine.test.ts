import { describe, expect, it } from "vitest";
import { explainSearchEngineError, SEARCH_PATTERN_HINT } from "./regexEngine";

// The engine's own message, as the model received it: accurate, and silent
// about what to do instead.
const LOOK_AHEAD_ERROR =
  "bad regex: regex parse error:\n    (?:parseInt\\((?!\\s*[A-Za-z_$][\\w.$]*\\s*,))\n" +
  "                 ^^^\nerror: look-around, including look-ahead and look-behind, is not supported";

// Reproduced from ripgrep 15.2.0, which is the engine this tool wraps:
//   $ rg 'fetch\\([^)]+\\)\\s*\\n\\s*\\.then\\(' src
//   rg: the literal "\n" is not allowed in a regex
//   Consider enabling multiline mode with the --multiline flag (or -U for short).
// The engine's advice is unactionable here: this tool has no multiline mode.
const NEWLINE_ERROR = 'regex parse error: the literal "\\n" is not allowed in a regex';

describe("explainSearchEngineError", () => {
  it("keeps the engine's message and adds the rewrite for look-around", () => {
    const out = explainSearchEngineError(LOOK_AHEAD_ERROR);
    expect(out).toContain("look-around, including look-ahead and look-behind");
    expect(out).toContain("This engine has no look-around");
    expect(out).toContain("read the hits");
  });

  it("explains backreferences", () => {
    const out = explainSearchEngineError(
      "bad regex: backreferences are not supported",
    );
    expect(out).toContain("backreferences are not supported");
    expect(out).toContain("no backreferences");
  });

  it("explains a repetition operator with nothing to repeat", () => {
    const out = explainSearchEngineError(
      "regex parse error:\n    *foo\nerror: repetition operator missing expression",
    );
    expect(out).toContain("Escape the literal character");
  });

  // The case this was missing. A newline in the pattern previously fell through
  // to the generic dialect note, so the model was told to avoid look-around when
  // the actual limit was that a match cannot cross a line - and the engine's own
  // suggestion (enable multiline) is not available in this tool. The point is
  // that the advice names the real limit and a substitute that works.
  it("explains that a pattern cannot cross a newline", () => {
    const out = explainSearchEngineError(NEWLINE_ERROR);
    expect(out).toContain("one line at a time");
    expect(out).toContain("cannot cross a newline");
    expect(out).toContain("no multiline mode");
    // And the substitute must be a grep that this tool actually supports.
    expect(out).toContain("read the lines around each hit");
  });

  // The failure in the report was made worse by the generic note riding along:
  // it answers a newline error with look-around and backreferences, which are
  // not the problem and invite a retry that changes the wrong thing.
  it("does not answer a known limit with the unrelated dialect note", () => {
    expect(explainSearchEngineError(NEWLINE_ERROR)).not.toContain(
      SEARCH_PATTERN_HINT,
    );
  });

  it("names the dialect for a limit it does not recognise", () => {
    const out = explainSearchEngineError("some new engine complaint");
    expect(out).toContain("some new engine complaint");
    expect(out).toContain(SEARCH_PATTERN_HINT);
  });

  it("survives an empty error", () => {
    expect(explainSearchEngineError("")).toContain("pattern rejected");
    expect(explainSearchEngineError("   ")).toContain("pattern rejected");
  });

  // A model that only ever sees the generic note would retry the same
  // construct; every limit named here has to be actionable.
  it("gives the known limits distinct advice", () => {
    const lookAround = explainSearchEngineError("error: look-around");
    const group = explainSearchEngineError("error: unclosed group");
    expect(lookAround).not.toBe(group);
  });
});

describe("SEARCH_PATTERN_HINT", () => {
  it("names both unsupported constructs and what still works", () => {
    expect(SEARCH_PATTERN_HINT).toContain("look-around");
    expect(SEARCH_PATTERN_HINT).toContain("backreferences");
    expect(SEARCH_PATTERN_HINT).toContain("Alternation");
  });

  // Prevention: the hint is in the tool description, so a model that reads it
  // does not write `\n` into a pattern in the first place. That only works if
  // the one-line limit is stated there.
  it("states the one-line limit up front", () => {
    expect(SEARCH_PATTERN_HINT).toContain("ONE line");
    expect(SEARCH_PATTERN_HINT).toContain("cannot span a newline");
  });

  it("has no em-dash", () => {
    expect(SEARCH_PATTERN_HINT).not.toContain("\u2014");
  });
});
