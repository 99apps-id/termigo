import { describe, expect, it } from "vitest";
import { searchCode, getIndexStats } from "../lib/codeIndex";

describe("codeIndex", () => {
  it("returns empty results when index is empty", () => {
    expect(getIndexStats()).toEqual({ files: 0, chunks: 0 });
    expect(searchCode("anything")).toEqual([]);
  });
});
