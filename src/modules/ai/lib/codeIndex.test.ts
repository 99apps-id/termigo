import { describe, expect, it, vi } from "vitest";
import {
  tokenize,
  searchCode,
  getIndexStats,
  indexWorkspace,
  INDEXABLE_EXTENSIONS,
  chunkLines,
  findScopeHeader,
  clearIndex,
  CODE_INDEX_CACHE_REL_PATH,
  saveIndexCache,
  loadIndexCache,
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

describe("syntax-aware chunkLines and findScopeHeader", () => {
  it("detects scope header for function, class, and interface", () => {
    const lines = [
      "export class TokenManager {",
      "  private token: string;",
      "  constructor() {",
      "    this.token = '';",
      "  }",
      "}",
    ];
    expect(findScopeHeader(lines, 3)).toContain("TokenManager");
    expect(findScopeHeader(lines, 0)).toContain("TokenManager");
  });

  it("chunks lines with boundary awareness and scope metadata", () => {
    const dummyLines = Array.from({ length: 120 }, (_, i) => {
      if (i === 0) return "export function runProcess() {";
      if (i === 70) return "export function nextStage() {";
      return `  const x_${i} = ${i};`;
    });

    const chunks = chunkLines(dummyLines);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].scopeHeader).toContain("runProcess");
  });
});

describe("code index persistence and cache", () => {
  it("saves and loads index cache correctly", async () => {
    const { native } = await import("./native");
    const writtenFiles = new Map<string, string>();
    vi.spyOn(native, "readFile").mockImplementation(async (p) => {
      const c = writtenFiles.get(p);
      if (c) return { kind: "text", content: c, size: c.length };
      return { kind: "text", content: "", size: 0 };
    });
    vi.spyOn(native, "writeFile").mockImplementation(async (p, content) => {
      writtenFiles.set(p, content);
    });
    vi.spyOn(native, "createDir").mockResolvedValue(
      undefined as unknown as void,
    );
    vi.spyOn(native, "glob").mockResolvedValue({
      hits: [{ path: "/workspace/src/auth.ts", rel: "src/auth.ts" }],
      truncated: false,
    });

    // Mock initial read of file
    const fileContent =
      "export function authenticateUser(token: string) { return true; }";
    writtenFiles.set("/workspace/src/auth.ts", fileContent);

    // Initial indexing builds and caches
    const stats1 = await indexWorkspace("/workspace");
    expect(stats1.files).toBe(1);
    expect(stats1.chunks).toBeGreaterThan(0);

    const cacheFile = writtenFiles.get(
      `/workspace/${CODE_INDEX_CACHE_REL_PATH}`,
    );
    expect(cacheFile).toBeDefined();
    expect(cacheFile).toContain("authenticateUser");

    // Clear memory index
    clearIndex();
    expect(getIndexStats().chunks).toBe(0);

    // Second call loads from cache without calling glob
    const globSpy = vi.spyOn(native, "glob");
    globSpy.mockClear();

    const stats2 = await indexWorkspace("/workspace");
    expect(stats2.files).toBe(1);
    expect(stats2.chunks).toBe(stats1.chunks);
    expect(globSpy).not.toHaveBeenCalled();

    // Forced reindex bypasses cache and calls glob
    const stats3 = await indexWorkspace("/workspace", true);
    expect(stats3.files).toBe(1);
    expect(globSpy).toHaveBeenCalled();

    // Verify search works on loaded index
    const results = searchCode("authenticateUser");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("/workspace/src/auth.ts");
  });
});

