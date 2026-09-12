import { describe, expect, it } from "vitest";
import { explainSearchEngineError, SEARCH_PATTERN_HINT } from "./regexEngine";

// The engine's own message, as the model received it: accurate, and silent
// about what to do instead.
const LOOK_AHEAD_ERROR =
  "bad regex: regex parse error:\n    (?:parseInt\\((?!\\s*[A-Za-z_$][\\w.$]*\\s*,))\n" +
  "                 ^^^\nerror: look-around, including look-ahead and look-behind, is not supported";

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

  it("has no em-dash", () => {
    expect(SEARCH_PATTERN_HINT).not.toContain("\u2014");
  });
});
