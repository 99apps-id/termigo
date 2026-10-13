import { describe, expect, it } from "vitest";
import { collectMarks } from "./EditorMinimap";

describe("collectMarks", () => {
  it("maps 1-based diagnostic lines to 0-based rows", () => {
    const marks = collectMarks([{ line: 1, severity: "error" }]);
    expect(marks.get(0)).toBe("error");
  });

  it("keeps the highest severity per row", () => {
    const marks = collectMarks([
      { line: 5, severity: "hint" },
      { line: 5, severity: "info" },
      { line: 5, severity: "warning" },
      { line: 5, severity: "error" },
      { line: 5, severity: "warning" },
    ]);
    expect(marks.get(4)).toBe("error");
  });

  it("ignores non-positive lines and missing input", () => {
    expect(collectMarks(undefined).size).toBe(0);
    expect(collectMarks([{ line: 0, severity: "error" }]).size).toBe(0);
  });
});
