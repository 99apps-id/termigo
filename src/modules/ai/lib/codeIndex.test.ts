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
  INDEXABLE_GLOB,
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

  it("walks every indexable extension in a single glob", () => {
    expect(INDEXABLE_GLOB.startsWith("**/*.{")).toBe(true);
    expect(INDEXABLE_GLOB.endsWith("}")).toBe(true);
    for (const ext of INDEXABLE_EXTENSIONS) {
      expect(INDEXABLE_GLOB).toContain(ext.slice(1));
    }
    // One alternation set, not one pattern per extension: the walk is the
    // expensive part and it used to run once per extension.
    expect(INDEXABLE_GLOB.split("{")).toHaveLength(2);
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

const FILE_CONTENT =
  "export function authenticateUser(token: string) { return true; }";

/** A native mock whose glob reports one file with a settable fingerprint. */
async function mockNativeTree(writtenFiles: Map<string, string>) {
  const { native } = await import("./native");
  writtenFiles.set("/workspace/src/auth.ts", FILE_CONTENT);
  vi.spyOn(native, "readFile").mockImplementation(async (p) => {
    const c = writtenFiles.get(p);
    if (c) return { kind: "text", content: c, size: c.length };
    return { kind: "text", content: "", size: 0 };
  });
  vi.spyOn(native, "writeFile").mockImplementation(async (p, content) => {
    writtenFiles.set(p, content);
  });
  vi.spyOn(native, "createDir").mockResolvedValue(
    undefined as unknown as undefined,
  );
  vi.spyOn(native, "glob").mockResolvedValue({
    hits: [
      {
        path: "/workspace/src/auth.ts",
        rel: "src/auth.ts",
        mtime: 1000,
        size: FILE_CONTENT.length,
      },
    ],
    truncated: false,
  });
  return native;
}

describe("code index persistence and cache", () => {
  it("saves the index and reuses it while the tree is unchanged", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);

    const stats1 = await indexWorkspace("/workspace", false, true);
    expect(stats1.files).toBe(1);
    expect(stats1.chunks).toBeGreaterThan(0);

    const cacheFile = writtenFiles.get(
      `/workspace/${CODE_INDEX_CACHE_REL_PATH}`,
    );
    expect(cacheFile).toBeDefined();
    expect(cacheFile).toContain("authenticateUser");

    clearIndex();
    expect(getIndexStats().chunks).toBe(0);

    // An unchanged tree is served from the cache: the freshness check stats
    // files, it does not re-read their contents.
    const readSpy = vi.spyOn(native, "readFile");
    readSpy.mockClear();

    const stats2 = await indexWorkspace("/workspace");
    expect(stats2.files).toBe(1);
    expect(stats2.chunks).toBe(stats1.chunks);
    expect(readSpy).not.toHaveBeenCalledWith("/workspace/src/auth.ts");

    const results = searchCode("authenticateUser");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("/workspace/src/auth.ts");
  });

  it("rebuilds instead of trusting a cache whose files changed", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);

    await indexWorkspace("/workspace", false, true);
    expect(writtenFiles.has(`/workspace/${CODE_INDEX_CACHE_REL_PATH}`)).toBe(
      true,
    );

    clearIndex();

    // Same path, new mtime and size: the cached chunks describe a file that no
    // longer exists in that shape, so they must not answer a search.
    vi.mocked(native.glob).mockResolvedValue({
      hits: [
        {
          path: "/workspace/src/auth.ts",
          rel: "src/auth.ts",
          mtime: 2000,
          size: FILE_CONTENT.length + 10,
        },
      ],
      truncated: false,
    });

    const readSpy = vi.spyOn(native, "readFile");
    readSpy.mockClear();

    const stats = await indexWorkspace("/workspace");
    expect(stats.files).toBe(1);
    expect(readSpy).toHaveBeenCalledWith("/workspace/src/auth.ts");
  });

  it("writes a cache only for the workspace root", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);
    vi.mocked(native.glob).mockResolvedValue({
      hits: [
        {
          path: "/other-checkout/src/auth.ts",
          rel: "src/auth.ts",
          mtime: 1000,
          size: FILE_CONTENT.length,
        },
      ],
      truncated: false,
    });
    writtenFiles.set("/other-checkout/src/auth.ts", FILE_CONTENT);

    await indexWorkspace("/other-checkout");
    expect(
      writtenFiles.has(`/other-checkout/${CODE_INDEX_CACHE_REL_PATH}`),
    ).toBe(false);

    await indexWorkspace("/other-checkout", false, true);
    expect(
      writtenFiles.has(`/other-checkout/${CODE_INDEX_CACHE_REL_PATH}`),
    ).toBe(true);
  });
});
