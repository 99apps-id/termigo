import { describe, expect, it } from "vitest";
import {
  scanConflictLines,
  scanTextForConflicts,
  summarizeConflicts,
} from "./conflicts";

describe("scanConflictLines", () => {
  it("detects standard two-way merge conflict", () => {
    const lines = [
      "const a = 1;",
      "<<<<<<< HEAD",
      "const b = 2;",
      "=======",
      "const b = 3;",
      ">>>>>>> feature",
      "const c = 4;",
    ];

    const blocks = scanConflictLines(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(2);
    expect(blocks[0].separatorLine).toBe(4);
    expect(blocks[0].endLine).toBe(6);
    expect(blocks[0].oursLabel).toBe("HEAD");
    expect(blocks[0].theirsLabel).toBe("feature");
    expect(blocks[0].oursLines).toEqual(["const b = 2;"]);
    expect(blocks[0].theirsLines).toEqual(["const b = 3;"]);
    expect(blocks[0].baseLine).toBeUndefined();
  });

  it("detects three-way diff3 merge conflict", () => {
    const lines = [
      "<<<<<<< HEAD",
      "local change",
      "||||||| base-commit",
      "original line",
      "=======",
      "incoming change",
      ">>>>>>> branch-a",
    ];

    const blocks = scanConflictLines(lines, 10);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(10);
    expect(blocks[0].baseLine).toBe(12);
    expect(blocks[0].separatorLine).toBe(14);
    expect(blocks[0].endLine).toBe(16);
    expect(blocks[0].oursLabel).toBe("HEAD");
    expect(blocks[0].baseLabel).toBe("base-commit");
    expect(blocks[0].theirsLabel).toBe("branch-a");
    expect(blocks[0].oursLines).toEqual(["local change"]);
    expect(blocks[0].baseLines).toEqual(["original line"]);
    expect(blocks[0].theirsLines).toEqual(["incoming change"]);
  });

  it("handles CRLF lines correctly", () => {
    const text = "<<<<<<< HEAD\r\nline1\r\n=======\r\nline2\r\n>>>>>>> remote\r\n";
    const blocks = scanTextForConflicts(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].oursLines).toEqual(["line1"]);
    expect(blocks[0].theirsLines).toEqual(["line2"]);
  });

  it("detects multiple conflict blocks in one file", () => {
    const lines = [
      "<<<<<<< A",
      "1",
      "=======",
      "2",
      ">>>>>>> B",
      "clean",
      "<<<<<<< C",
      "3",
      "=======",
      "4",
      ">>>>>>> D",
    ];

    const blocks = scanConflictLines(lines);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].oursLabel).toBe("A");
    expect(blocks[1].oursLabel).toBe("C");
  });

  it("ignores unclosed conflict blocks", () => {
    const lines = ["<<<<<<< HEAD", "incomplete", "=======", "still waiting"];
    const blocks = scanConflictLines(lines);
    expect(blocks).toHaveLength(0);
  });

  it("produces concise conflict summaries", () => {
    const lines = [
      "<<<<<<< HEAD",
      "foo",
      "=======",
      "bar",
      ">>>>>>> main",
    ];
    const blocks = scanConflictLines(lines);
    const summaries = summarizeConflicts(blocks);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].oursPreview).toBe("foo");
    expect(summaries[0].theirsPreview).toBe("bar");
  });
});
