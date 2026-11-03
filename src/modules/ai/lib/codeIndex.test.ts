import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  tokenize,
  searchCode,
  getIndexStats,
  indexWorkspace,
  queryTokens,
  INDEXABLE_EXTENSIONS,
  chunkLines,
  findScopeHeader,
  clearIndex,
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

  it("splits digit-to-letter humps and underscore-wrapped stems", () => {
    expect(tokenize("sha256Hash")).toContain("hash");
    expect(tokenize("base64Encode")).toContain("base64");
    expect(tokenize("__init__")).toContain("init");
    expect(tokenize("_private")).toContain("private");
  });

  it("counts a repeated sub-token once per word", () => {
    const tokens = tokenize("fooFoo");
    expect(tokens.filter((t) => t === "foo")).toHaveLength(1);
  });
});

describe("searchCode with empty or null workspace", () => {
  it("returns empty results when index is empty", async () => {
    expect(getIndexStats()).toEqual({ files: 0, chunks: 0, truncated: false });
    await expect(searchCode("anything")).resolves.toEqual([]);
  });

  it("returns 0 files and chunks when root is null", async () => {
    const res = await indexWorkspace(null);
    expect(res).toEqual({ files: 0, chunks: 0, truncated: false });
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

describe("queryTokens", () => {
  it("dedupes repeated terms without dropping sub-tokens", () => {
    expect(queryTokens("token token authenticateUser")).toEqual([
      "token",
      "authenticateuser",
      "authenticate",
      "user",
    ]);
  });
});

type Stamp = { path: string; mtime: number; size: number };
type FtsFilePayload = {
  path: string;
  mtime: number;
  size: number;
  pathTokens: string;
  chunks: { tokens: string; text: string }[];
};

/** A contract double for the Rust FTS5 side: it stores the stamps a
 *  replace reported and answers freshness by comparing them, the same
 *  semantics codeindex.rs implements against SQLite. */
function mockFtsBackend() {
  const stored = new Map<
    string,
    { stamps: Stamp[]; files: number; chunks: number }
  >();
  const replaced: { root: string; files: FtsFilePayload[] }[] = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(
    async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "codeindex_check_fresh") {
        const { root, files } = args as unknown as {
          root: string;
          files: Stamp[];
        };
        const entry = stored.get(root);
        const fresh =
          !!entry &&
          entry.chunks > 0 &&
          entry.stamps.length === files.length &&
          files.every((f) =>
            entry.stamps.some(
              (s) =>
                s.path === f.path && s.mtime === f.mtime && s.size === f.size,
            ),
          );
        return {
          fresh,
          files: entry?.files ?? 0,
          chunks: entry?.chunks ?? 0,
        };
      }
      if (cmd === "codeindex_replace_root") {
        const { root, files } = args as unknown as {
          root: string;
          files: FtsFilePayload[];
        };
        replaced.push({ root, files });
        const chunks = files.reduce((n, f) => n + f.chunks.length, 0);
        stored.set(root, {
          stamps: files.map((f) => ({
            path: f.path,
            mtime: f.mtime,
            size: f.size,
          })),
          files: files.length,
          chunks,
        });
        return { files: files.length, chunks };
      }
      if (cmd === "codeindex_search") return [];
      if (cmd === "fs_delete") return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    },
  );
  return { replaced };
}

describe("code index FTS5 storage", () => {
  it("builds once, then serves an unchanged tree without re-reading files", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);
    const { replaced } = mockFtsBackend();

    const stats1 = await indexWorkspace("/workspace");
    expect(stats1.files).toBe(1);
    expect(stats1.chunks).toBeGreaterThan(0);
    expect(replaced).toHaveLength(1);

    // The payload carries the pre-tokenized stream FTS5 indexes: the whole
    // identifier plus its split sub-tokens.
    const chunk = replaced[0]?.files[0]?.chunks[0];
    expect(chunk?.tokens).toContain("authenticateuser");
    expect(chunk?.tokens).toContain("authenticate");
    expect(chunk?.tokens).toContain("user");
    expect(replaced[0]?.files[0]?.pathTokens).toContain("auth");

    clearIndex();
    expect(getIndexStats().chunks).toBe(0);

    const readSpy = vi.spyOn(native, "readFile");
    readSpy.mockClear();

    const stats2 = await indexWorkspace("/workspace");
    expect(stats2).toEqual(stats1);
    expect(readSpy).not.toHaveBeenCalledWith("/workspace/src/auth.ts");
    expect(replaced).toHaveLength(1);
  });

  it("rebuilds when a file fingerprint changed", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);
    const { replaced } = mockFtsBackend();

    await indexWorkspace("/workspace");
    clearIndex();

    // Same path, new mtime and size: the stored chunks describe a file that
    // no longer exists in that shape, so they must not answer a search.
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
    expect(replaced).toHaveLength(2);
  });

  it("never writes an index file into the searched tree", async () => {
    const writtenFiles = new Map<string, string>();
    const native = await mockNativeTree(writtenFiles);
    mockFtsBackend();
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
    await indexWorkspace("/other-checkout", true);

    // The FTS5 database lives in the app data directory. The old JSON cache
    // planted a copy of the corpus in every workspace root it indexed.
    expect(vi.mocked(native.writeFile)).not.toHaveBeenCalled();
  });
});
