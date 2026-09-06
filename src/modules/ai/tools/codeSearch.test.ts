import { describe, expect, it } from "vitest";
import { searchCode, getIndexStats } from "../lib/codeIndex";
import { buildCodeSearchTools } from "./codeSearch";

describe("codeSearch tools", () => {
  const fakeCtx = {
    getWorkspaceRoot: () => "C:/fake/project",
    getCwd: () => "C:/fake/project",
  } as never;

  it("builds code_search and code_index tools", () => {
    const tools = buildCodeSearchTools(fakeCtx);
    expect(tools.code_search).toBeDefined();
    expect(tools.code_index).toBeDefined();
  });

  it("returns empty results when index is empty", () => {
    expect(getIndexStats()).toEqual({ files: 0, chunks: 0 });
    expect(searchCode("anything")).toEqual([]);
  });
});
