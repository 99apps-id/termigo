import { beforeEach, describe, expect, it, vi } from "vitest";

// The real indexer walks the filesystem; these tests are about WHICH root it is
// asked for and which index answers, so it is replaced wholesale.
vi.mock("../lib/codeIndex", () => ({
  indexWorkspace: vi.fn(),
  getIndexStats: vi.fn(),
  getIndexedRoot: vi.fn(),
  searchCode: vi.fn(),
}));

import {
  getIndexStats,
  getIndexedRoot,
  indexWorkspace,
  searchCode,
} from "../lib/codeIndex";
import { buildCodeSearchTools } from "./codeSearch";

const m = {
  indexWorkspace: vi.mocked(indexWorkspace),
  getIndexStats: vi.mocked(getIndexStats),
  getIndexedRoot: vi.mocked(getIndexedRoot),
  searchCode: vi.mocked(searchCode),
};

const WORKSPACE = "C:/fake/project";

/** A stand-in index whose loaded root and size this test controls. */
let loadedRoot: string | null = null;
let loadedChunks = 0;

function tools(cwd = WORKSPACE) {
  return buildCodeSearchTools({
    getWorkspaceRoot: () => WORKSPACE,
    getCwd: () => cwd,
  } as never);
}

/** The AI SDK types `execute` as possibly absent; the tools always define it. */
type Run = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const run = (t: unknown): Run => (t as { execute: Run }).execute;

beforeEach(() => {
  vi.clearAllMocks();
  loadedRoot = null;
  loadedChunks = 0;
  m.getIndexedRoot.mockImplementation(() => loadedRoot);
  m.getIndexStats.mockImplementation(() => ({
    files: loadedChunks > 0 ? 1 : 0,
    chunks: loadedChunks,
  }));
  m.indexWorkspace.mockImplementation(async (root: string) => {
    loadedRoot = root;
    loadedChunks = 10;
    return { files: 1, chunks: 10 };
  });
  m.searchCode.mockReturnValue([]);
});

describe("code_index / code_search root targeting", () => {
  it("indexes the workspace root when no root is given", async () => {
    await run(tools().code_index)({});

    expect(m.indexWorkspace).toHaveBeenCalledWith(WORKSPACE, true);
  });

  it("indexes an explicit root instead of the workspace", async () => {
    // The case that motivated the parameter: auditing a repo that is not the
    // open workspace. Before this, the only reachable tree was the workspace,
    // so the other repo was crawled one directory at a time with `ls`.
    await run(tools().code_index)({ root: "C:/project/other-repo" });

    expect(m.indexWorkspace).toHaveBeenCalledWith("C:/project/other-repo", true);
  });

  it("resolves a relative root against the active terminal cwd", async () => {
    await run(tools("C:/fake/project/src"))({ root: "../other-repo" });

    expect(m.indexWorkspace).toHaveBeenCalledWith(
      "C:/fake/project/src/../other-repo",
      true,
    );
  });

  it("searches the requested root without re-indexing the workspace", async () => {
    loadedRoot = "C:/project/other-repo";
    loadedChunks = 10;

    const result = await run(tools().code_search)({
      query: "pty session",
      root: "C:/project/other-repo",
    });

    // Already indexed for this root, so no rebuild is triggered...
    expect(m.indexWorkspace).not.toHaveBeenCalled();
    // ...and the caller is told WHICH tree answered, so a cross-repo audit
    // cannot mistake the workspace's hits for the other repo's.
    expect(result.searched).toBe("C:/project/other-repo");
    expect(m.searchCode).toHaveBeenCalledWith("pty session", 10, undefined);
  });

  it("requests the other repo's index rather than answering from the workspace", async () => {
    // The workspace is indexed and ready...
    loadedRoot = WORKSPACE;
    loadedChunks = 10;

    await run(tools().code_search)({
      query: "anything",
      root: "C:/project/other-repo",
    });

    // ...but a search of a DIFFERENT root must not accept it.
    expect(m.indexWorkspace).toHaveBeenCalledWith(
      "C:/project/other-repo",
      false,
    );
  });

  it("does not hand an in-flight build for one root to a caller asking about another", async () => {
    // Regression: `indexingPromise` used to be a bare promise, so a build
    // started for repo A was awaited and returned to a caller asking about repo
    // B. A then answered a search the model believed was scoped to B, with no
    // error anywhere. Concurrency is not the common case, but the failure is
    // silent, so it is pinned here.
    let release: ((v: { files: number; chunks: number }) => void) | undefined;
    m.indexWorkspace.mockImplementationOnce(
      () =>
        new Promise<{ files: number; chunks: number }>((resolve) => {
          release = resolve;
        }),
    );
    const t = tools();

    const a = run(t.code_index)({ root: "C:/repo-a" });
    const b = run(t.code_index)({ root: "C:/repo-b" });

    expect(m.indexWorkspace).toHaveBeenCalledTimes(2);
    expect(m.indexWorkspace).toHaveBeenNthCalledWith(1, "C:/repo-a", true);
    expect(m.indexWorkspace).toHaveBeenNthCalledWith(2, "C:/repo-b", true);

    release?.({ files: 1, chunks: 10 });
    await Promise.all([a, b]);
  });

  it("returns a clear error instead of silent empty results when the root has nothing to index", async () => {
    // A typo'd path must not read as "this repo contains no matches", which is
    // a conclusion the model would happily report to the user.
    m.indexWorkspace.mockImplementation(async () => {
      loadedRoot = "C:/nope";
      loadedChunks = 0;
      return { files: 0, chunks: 0 };
    });

    const result = await run(tools().code_search)({
      query: "x",
      root: "C:/nope",
    });

    expect(String(result.error)).toContain("C:/nope");
    expect(m.searchCode).not.toHaveBeenCalled();
  });
});
