import { describe, expect, it } from "vitest";
import {
  escapeRegex,
  isSelfReferential,
  replaceAllCount,
  uniquePaths,
} from "./replaceText";

describe("escapeRegex", () => {
  // The search is literal but the grep backend takes a regex. Without escaping,
  // a dot or bracket would silently match more than the user asked for.
  it("neutralises regex metacharacters", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
    expect(escapeRegex("cost($)")).toBe("cost\\(\\$\\)");
    expect(escapeRegex("arr[0]")).toBe("arr\\[0\\]");
    expect(escapeRegex("a|b")).toBe("a\\|b");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeRegex("renameThis")).toBe("renameThis");
  });
});

describe("replaceAllCount", () => {
  it("replaces every occurrence and counts them", () => {
    const out = replaceAllCount("a b a b a", "a", "X");
    expect(out.content).toBe("X b X b X");
    expect(out.count).toBe(3);
  });

  it("reports zero and returns the original when nothing matches", () => {
    const input = "nothing here";
    const out = replaceAllCount(input, "missing", "X");
    expect(out.count).toBe(0);
    expect(out.content).toBe(input);
  });

  it("treats the search as literal text, not a pattern", () => {
    const out = replaceAllCount("a.b axb", "a.b", "Z");
    expect(out.content).toBe("Z axb");
    expect(out.count).toBe(1);
  });

  // Walking forward past each match is what stops a replacement that contains
  // the search text from matching itself forever.
  it("does not rescan its own output", () => {
    const out = replaceAllCount("foo", "foo", "foofoo");
    expect(out.content).toBe("foofoo");
    expect(out.count).toBe(1);
  });

  it("supports deleting text with an empty replacement", () => {
    expect(replaceAllCount("a-b-c", "-", "").content).toBe("abc");
  });

  it("refuses an empty search rather than looping", () => {
    const out = replaceAllCount("abc", "", "X");
    expect(out).toEqual({ content: "abc", count: 0 });
  });

  it("handles multi-line content", () => {
    const out = replaceAllCount("line1\nold\nline3\nold", "old", "new");
    expect(out.content).toBe("line1\nnew\nline3\nnew");
    expect(out.count).toBe(2);
  });
});

describe("isSelfReferential", () => {
  // Running such a replace twice keeps growing the file, which is worth
  // warning about rather than letting the model discover the mess.
  it("spots a replacement that contains the search", () => {
    expect(isSelfReferential("foo", "foo_bar")).toBe(true);
    expect(isSelfReferential("v1", "v1.1")).toBe(true);
  });

  it("is false for an ordinary rename", () => {
    expect(isSelfReferential("oldName", "newName")).toBe(false);
  });

  it("is false for an empty search", () => {
    expect(isSelfReferential("", "anything")).toBe(false);
  });
});

describe("uniquePaths", () => {
  it("collapses the many hits per file grep returns", () => {
    expect(
      uniquePaths([{ path: "a.ts" }, { path: "a.ts" }, { path: "b.ts" }]),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps first-seen order", () => {
    expect(uniquePaths([{ path: "z" }, { path: "a" }, { path: "z" }])).toEqual([
      "z",
      "a",
    ]);
  });

  it("handles no hits", () => {
    expect(uniquePaths([])).toEqual([]);
  });
});
