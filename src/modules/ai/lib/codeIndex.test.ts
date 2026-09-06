import { describe, expect, it, vi } from "vitest";
import {
  tokenize,
  searchCode,
  getIndexStats,
  indexWorkspace,
  INDEXABLE_EXTENSIONS,
} from "./codeIndex";

describe("tokenize", () => {
  it("splits simple words and strips stop words", () => {
    const tokens = tokenize("The quick brown fox is jumping over a lazy dog");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
    expect(tokens).toContain("fox");
    expect(tokens).toContain("jumping");
    expect(tokens).toContain("lazy");
    expect(tokens).toContain("dog");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("is");
    expect(tokens).not.toContain("over");
  });

  it("splits camelCase and PascalCase into sub-tokens", () => {
    const tokens = tokenize("isReadOnlyCommand UserAuthenticationManager");
    expect(tokens).toContain("isreadonlycommand");
    expect(tokens).toContain("read");
    expect(tokens).toContain("command");
    expect(tokens).toContain("userauthenticationmanager");
    expect(tokens).toContain("user");
    expect(tokens).toContain("authentication");
    expect(tokens).toContain("manager");
  });

  it("splits snake_case and SCREAMING_SNAKE into sub-tokens", () => {
    const tokens = tokenize("check_writable MAX_RETRY_COUNT");
    expect(tokens).toContain("check_writable");
    expect(tokens).toContain("check");
    expect(tokens).toContain("writable");
    expect(tokens).toContain("max_retry_count");
    expect(tokens).toContain("max");
    expect(tokens).toContain("retry");
    expect(tokens).toContain("count");
  });
});

describe("searchCode with empty or null workspace", () => {
  it("returns empty results when index is empty", () => {
    expect(getIndexStats()).toEqual({ files: 0, chunks: 0 });
    expect(searchCode("anything")).toEqual([]);
  });

  it("returns 0 files and chunks when root is null", async () => {
    const res = await indexWorkspace(null);
    expect(res).toEqual({ files: 0, chunks: 0 });
  });

  it("includes common source and configuration extensions", () => {
    expect(INDEXABLE_EXTENSIONS).toContain(".ts");
    expect(INDEXABLE_EXTENSIONS).toContain(".py");
    expect(INDEXABLE_EXTENSIONS).toContain(".rs");
    expect(INDEXABLE_EXTENSIONS).toContain(".go");
    expect(INDEXABLE_EXTENSIONS).toContain(".json");
    expect(INDEXABLE_EXTENSIONS).toContain(".yaml");
    expect(INDEXABLE_EXTENSIONS).toContain(".sql");
  });
});
