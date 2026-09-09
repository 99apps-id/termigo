import { describe, expect, it } from "vitest";
import {
  DOMINANCE_RATIO,
  isRepetitionDominated,
  MIN_FRAGMENT_LENGTH,
  MIN_REPEAT_COUNT,
  REPEAT_WINDOW,
} from "./repetitionGuard";

describe("isRepetitionDominated", () => {
  it("fails open for non-string input", () => {
    expect(isRepetitionDominated(undefined)).toBe(false);
    expect(isRepetitionDominated(null)).toBe(false);
    expect(isRepetitionDominated(42)).toBe(false);
    expect(isRepetitionDominated({ text: "x" })).toBe(false);
  });

  it("fails open for text below the minimum fragment length", () => {
    // Even a pure echo is kept when short — short truncations trivially
    // contain repeated tokens.
    const frag = "a".repeat(MIN_FRAGMENT_LENGTH - 1);
    expect(isRepetitionDominated(frag)).toBe(false);
  });

  it("detects one long line echoed many times (line fast path)", () => {
    const line = "The quick brown fox jumps over the lazy dog again and again";
    const text = Array.from({ length: MIN_REPEAT_COUNT + 5 }, () => line).join(
      "\n",
    );
    expect(isRepetitionDominated(text)).toBe(true);
  });

  it("detects a loop that does not align to line boundaries (window path)", () => {
    // One continuous stream of a 60+ char fragment with no newlines.
    const frag =
      "echo echo echo echo echo echo echo echo echo echo echo echo!!";
    expect(frag.length).toBeGreaterThanOrEqual(REPEAT_WINDOW);
    const text = frag.repeat(30);
    expect(text.includes("\n")).toBe(false);
    expect(isRepetitionDominated(text)).toBe(true);
  });

  it("keeps ordinary prose with incidental repeats", () => {
    // Varied sentences that reuse some phrasing — below the dominance ratio.
    const sentences = [
      "The module exports a single function used by the runtime.",
      "It checks the ledger before sending the follow-up nudge.",
      "The runtime then patches the agent metadata for the session.",
      "A preference gates the whole behaviour and defaults to off.",
      "Tests cover the ledger fold and the nudge builder separately.",
      "The module exports a single function used by the runtime.",
      "It checks the ledger before sending the follow-up nudge.",
    ];
    const text = sentences.join(" ");
    expect(text.length).toBeGreaterThan(MIN_FRAGMENT_LENGTH);
    expect(isRepetitionDominated(text)).toBe(false);
  });

  it("keeps code with legitimately repeated lines below the dominance ratio", () => {
    const unique = Array.from(
      { length: 40 },
      (_, i) => `const value${i} = compute(${i}); // step ${i} of the pipeline`,
    ).join("\n");
    const repeated = Array.from({ length: 4 }, () => "  return null;").join(
      "\n",
    );
    const text = `${unique}\n${repeated}`;
    expect(isRepetitionDominated(text)).toBe(false);
  });

  it("does not trip when repeats cover less than half the fragment", () => {
    // 10 echoes of a 60-char line (600 chars) inside 4000 chars of unique
    // filler: coverage ~15%, far below DOMINANCE_RATIO.
    const line = "z".repeat(REPEAT_WINDOW);
    const echoed = Array.from({ length: 10 }, () => line).join("\n");
    const filler = Array.from(
      { length: 60 },
      (_, i) => `unique filler line number ${i} with enough length to matter`,
    ).join("\n");
    const text = `${filler}\n${echoed}`;
    expect(text.length).toBeGreaterThan(MIN_FRAGMENT_LENGTH);
    expect(isRepetitionDominated(text)).toBe(false);
  });

  it("trips exactly at the minimum repeat count when it dominates", () => {
    const line = "b".repeat(100);
    const text = Array.from({ length: MIN_REPEAT_COUNT }, () => line).join("\n");
    // 5 lines x 100 chars = 500 chars >= MIN_FRAGMENT_LENGTH, coverage = 1.
    expect(text.length).toBeGreaterThanOrEqual(MIN_FRAGMENT_LENGTH);
    expect(isRepetitionDominated(text)).toBe(true);
  });

  it("keeps a fragment of entirely unique characters", () => {
    // No window can repeat when every 60-char slice is unique.
    let text = "";
    let i = 0;
    while (text.length < MIN_FRAGMENT_LENGTH * 2) {
      text += `seg${i.toString(36).padStart(6, "0")}-`;
      i++;
    }
    expect(isRepetitionDominated(text)).toBe(false);
  });

  it("ignores blank lines in the line fast path", () => {
    // Many empty lines must not count as a repeated line; the real content is
    // unique so nothing dominates.
    const unique = Array.from(
      { length: 30 },
      (_, i) => `line ${i.toString(36).padStart(4, "0")} of distinct content here`,
    ).join("\n");
    const text = `${unique}\n\n\n\n\n\n\n\n\n\n\n\n`;
    expect(text.length).toBeGreaterThan(MIN_FRAGMENT_LENGTH);
    expect(isRepetitionDominated(text)).toBe(false);
  });

  it("exposes the documented thresholds", () => {
    expect(MIN_FRAGMENT_LENGTH).toBe(400);
    expect(REPEAT_WINDOW).toBe(60);
    expect(MIN_REPEAT_COUNT).toBe(5);
    expect(DOMINANCE_RATIO).toBe(0.5);
  });
});
