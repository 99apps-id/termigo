import { describe, expect, it } from "vitest";
import { truncateProjectMemory } from "./transport";

const LIMIT = 10 * 1024;

describe("truncateProjectMemory", () => {
  it("leaves a document that already fits", () => {
    const doc = "# Project\n\nSmall enough.\n";
    expect(truncateProjectMemory(doc)).toBe(doc);
  });

  it("keeps the top of the document, which is where the overview is", () => {
    const doc = `# Overview\nthe important part\n${"x".repeat(LIMIT * 2)}`;
    const out = truncateProjectMemory(doc);
    expect(out.startsWith("# Overview\nthe important part")).toBe(true);
  });

  it("says it was cut, so the agent knows the rest exists", () => {
    const doc = `line\n`.repeat(LIMIT);
    expect(truncateProjectMemory(doc)).toMatch(/truncated here/);
  });

  // A blind slice ends mid-sentence, which reads as a fact that stops halfway
  // rather than a document that was cut short.
  it("cuts on a line boundary rather than mid-sentence", () => {
    const doc = `${"a".repeat(100)}\n`.repeat(LIMIT);
    const out = truncateProjectMemory(doc).replace(/\n\n\[TERMIGO.*$/s, "");
    for (const line of out.split("\n")) {
      expect(line === "" || line.length === 100).toBe(true);
    }
  });

  it("stays close to the budget rather than growing past it", () => {
    const out = truncateProjectMemory("y".repeat(LIMIT * 3));
    expect(out.length).toBeLessThan(LIMIT + 200);
  });

  it("still cuts a file with no line breaks at all", () => {
    const out = truncateProjectMemory("z".repeat(LIMIT * 2));
    expect(out.length).toBeLessThan(LIMIT + 200);
    expect(out).toMatch(/truncated here/);
  });
});
