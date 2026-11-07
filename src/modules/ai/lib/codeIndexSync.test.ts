import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIndex,
  indexWorkspace,
  invalidateIndexedPaths,
  searchCode,
} from "./codeIndex";

const CONTENT =
  "export function authenticateUser(token: string) { return true; }";

/** Seed the real indexer with one file, the same way codeIndex.test.ts does. */
async function seedIndex(root: string): Promise<void> {
  const { native } = await import("./native");
  const files = new Map<string, string>([[`${root}/src/auth.ts`, CONTENT]]);
  vi.spyOn(native, "readFile").mockImplementation(async (p) => {
    const c = files.get(p);
    return c
      ? ({ kind: "text", content: c, size: c.length, mtime: 1000 } as never)
      : ({ kind: "text", content: "", size: 0 } as never);
  });
  vi.spyOn(native, "glob").mockResolvedValue({
    hits: [
      {
        path: `${root}/src/auth.ts`,
        rel: "src/auth.ts",
        mtime: 1000,
        size: CONTENT.length,
      },
    ],
    truncated: false,
  } as never);
  await indexWorkspace(root);
}

describe("invalidateIndexedPaths", () => {
  beforeEach(() => {
    clearIndex();
    vi.restoreAllMocks();
  });

  it("drops a changed file so a later search cannot answer from stale chunks", async () => {
    await seedIndex("/workspace");
    expect(searchCode("authenticateUser").length).toBeGreaterThan(0);

    // The file changed on disk: the index must forget it rather than keep
    // serving the pre-edit text with the pre-edit line numbers.
    expect(invalidateIndexedPaths(["/workspace/src/auth.ts"])).toBe(1);
    expect(searchCode("authenticateUser")).toEqual([]);
  });

  it("matches a path spelled with the other separator", async () => {
    await seedIndex("/workspace");
    expect(invalidateIndexedPaths(["\\workspace\\src\\auth.ts"])).toBe(1);
    expect(searchCode("authenticateUser")).toEqual([]);
  });

  it("ignores empty and unknown input", () => {
    expect(invalidateIndexedPaths([])).toBe(0);
    expect(invalidateIndexedPaths([""])).toBe(0);
    expect(invalidateIndexedPaths([null as unknown as string])).toBe(0);
    expect(invalidateIndexedPaths(["/nowhere/x.ts"])).toBe(0);
  });

  it("keeps document frequencies consistent so BM25 stays usable", async () => {
    await seedIndex("/workspace");
    invalidateIndexedPaths(["/workspace/src/auth.ts"]);
    // A second file that shares no terms with the first still ranks: a
    // dangling document frequency would inflate its IDF and its score.
    const { native } = await import("./native");
    vi.spyOn(native, "readFile").mockImplementation(async (p) => {
      const c =
        p === "/workspace/src/other.ts"
          ? "export function buildReport() { return 1; }"
          : "";
      return { kind: "text", content: c, size: c.length, mtime: 2000 } as never;
    });
    vi.spyOn(native, "glob").mockResolvedValue({
      hits: [
        {
          path: "/workspace/src/other.ts",
          rel: "src/other.ts",
          mtime: 2000,
          size: 42,
        },
      ],
      truncated: false,
    } as never);
    await indexWorkspace("/workspace", true);
    const hits = searchCode("buildReport");
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe("/workspace/src/other.ts");
    expect(Number.isFinite(hits[0].score)).toBe(true);
  });
});
