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

  // The overlap used to be dead code: the step was
  // `Math.max(start + CHUNK_OVERLAP, end)`, which can never be below `end`
  // because the boundary search only lowers `end` to `start + CHUNK_OVERLAP`
  // at worst. Chunks were therefore strictly adjacent, so a declaration
  // straddling a boundary had its signature in one chunk and its body in the
  // next and no BM25 chunk ever saw both.
  it("overlaps consecutive chunks so a straddling declaration stays whole", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const chunks = chunkLines(lines);
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const overlap = chunks[i - 1].end - chunks[i].start;
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThanOrEqual(20);
    }
    // Every line is still covered exactly once by the union of the chunks.
    const covered = new Set<number>();
    for (const c of chunks) {
      for (let i = c.start; i < c.end; i++) covered.add(i);
    }
    expect(covered.size).toBe(lines.length);
  });

  it("keeps making progress on a file shorter than one chunk", () => {
    const chunks = chunkLines(["only one line"]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].end).toBe(1);
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

  // The freshness check compared the on-disk walk against the number of files
  // that reached the INDEX. Files the build skips (binary, over the size cap,
  // unreadable) are part of the tree but never indexed, so any tree containing
  // even one could never validate its own cache: every start rebuilt the whole
  // index and rewrote the same unusable file.
  it("reuses a cache when a tree file was skipped during the build", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);
    writtenFiles.set("/workspace/src/binary.ts", "text");
    vi.mocked(native.glob).mockResolvedValue({
      hits: [
        {
          path: "/workspace/src/auth.ts",
          rel: "src/auth.ts",
          mtime: 1000,
          size: FILE_CONTENT.length,
        },
        {
          path: "/workspace/src/generated.ts",
          rel: "src/generated.ts",
          mtime: 1000,
          size: 4,
        },
      ],
      truncated: false,
    });
    // A file the walk reports but the build cannot index (binary content).
    // Everything else, the cache file included, still comes from the tree.
    vi.mocked(native.readFile).mockImplementation(async (p) => {
      if (p === "/workspace/src/generated.ts") {
        return { kind: "binary", size: 4 } as never;
      }
      const c = writtenFiles.get(p);
      return c
        ? ({ kind: "text", content: c, size: c.length, mtime: 1000 } as never)
        : ({ kind: "text", content: "", size: 0 } as never);
    });

    const stats1 = await indexWorkspace("/workspace", false, true);
    expect(stats1.files).toBe(1);
    expect(writtenFiles.has(`/workspace/${CODE_INDEX_CACHE_REL_PATH}`)).toBe(
      true,
    );

    clearIndex();
    const readSpy = vi.spyOn(native, "readFile");
    readSpy.mockClear();

    const stats2 = await indexWorkspace("/workspace");
    expect(stats2.files).toBe(1);
    expect(readSpy).not.toHaveBeenCalledWith("/workspace/src/auth.ts");
  });

  it("drops a cache when a new file appears in the tree", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);
    await indexWorkspace("/workspace", false, true);
    clearIndex();

    vi.mocked(native.glob).mockResolvedValue({
      hits: [
        {
          path: "/workspace/src/auth.ts",
          rel: "src/auth.ts",
          mtime: 1000,
          size: FILE_CONTENT.length,
        },
        {
          path: "/workspace/src/extra.ts",
          rel: "src/extra.ts",
          mtime: 1000,
          size: 10,
        },
      ],
      truncated: false,
    });
    writtenFiles.set("/workspace/src/extra.ts", "export const x = 1;");

    const readSpy = vi.spyOn(native, "readFile");
    readSpy.mockClear();
    const stats = await indexWorkspace("/workspace");
    expect(stats.files).toBe(2);
    expect(readSpy).toHaveBeenCalledWith("/workspace/src/extra.ts");
  });
});
