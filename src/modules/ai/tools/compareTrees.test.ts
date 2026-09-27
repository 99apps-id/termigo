import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const nativeMock = vi.hoisted(() => ({
  glob: vi.fn(),
}));

vi.mock("../lib/native", () => ({
  native: nativeMock,
}));

import { buildTreeCompareTools } from "./compareTrees";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

type CompareResult = {
  error?: string;
  counts?: Record<string, number>;
  only_left?: string[];
  only_right?: string[];
  changed?: { path: string; left_size: number; right_size: number }[];
};

function makeContext(cwd: string | null = "/workspace"): ToolContext {
  return {
    getCwd: () => cwd,
    getWorkspaceRoot: () => cwd,
    getRemoteSession: () => null,
  } as unknown as ToolContext;
}

async function run(input: {
  left: string;
  right: string;
  path_filter?: string;
  max_results?: number;
  cwd?: string | null;
}): Promise<CompareResult> {
  // `??` would turn a deliberate null cwd back into the default, and the null
  // case is exactly what the resolvePath test is about.
  const cwd = "cwd" in input ? (input.cwd ?? null) : "/workspace";
  const tools = buildTreeCompareTools(makeContext(cwd));
  const execute = tools.compare_trees.execute;
  if (!execute) throw new Error("compare_trees execute missing");
  return (await execute(
    {
      left: input.left,
      right: input.right,
      ...(input.path_filter === undefined
        ? {}
        : { path_filter: input.path_filter }),
      ...(input.max_results === undefined
        ? {}
        : { max_results: input.max_results }),
    },
    toolOptions,
  )) as CompareResult;
}

const globOk = (
  entries: Record<string, { rel: string; size: number; mtime: number }[]>,
) =>
  nativeMock.glob.mockImplementation(
    async ({ root }: { root: string }) => ({
      hits: (entries[root] ?? []).map((e) => ({
        path: `${root}/${e.rel}`,
        rel: e.rel,
        mtime: e.mtime,
        size: e.size,
      })),
      truncated: false,
    }),
  );

describe("compare_trees", () => {
  beforeEach(() => {
    nativeMock.glob.mockReset();
  });

  it("reports which files exist on only one side", async () => {
    globOk({
      "/left": [{ rel: "a.ts", size: 1, mtime: 1 }],
      "/right": [{ rel: "b.ts", size: 1, mtime: 1 }],
    });

    const res = await run({ left: "/left", right: "/right" });

    expect(res.only_left).toEqual(["a.ts"]);
    expect(res.only_right).toEqual(["b.ts"]);
    expect(res.counts?.identical).toBe(0);
  });

  it("caps each category without changing the counts", async () => {
    globOk({
      "/left": [
        { rel: "a.ts", size: 1, mtime: 1 },
        { rel: "b.ts", size: 1, mtime: 1 },
        { rel: "c.ts", size: 1, mtime: 1 },
      ],
      "/right": [],
    });

    const res = await run({ left: "/left", right: "/right", max_results: 1 });

    expect(res.only_left).toEqual(["a.ts"]);
    expect(res.counts?.only_left).toBe(3);
  });

  it("refuses a comparison of a directory with itself", async () => {
    globOk({ "/left": [{ rel: "a.ts", size: 1, mtime: 1 }] });

    const res = await run({ left: "/left", right: "/left" });

    expect(res.error).toMatch(/same directory/);
    expect(nativeMock.glob).not.toHaveBeenCalled();
  });

  // A relative path with no terminal cwd used to throw out of `execute`, which
  // the SDK turned into a fatal tool error. It is a correctable argument, so it
  // has to come back as an `{ error }` the model can read.
  it("returns an error, not a throw, for a relative path with no cwd", async () => {
    const res = await run({ left: "left", right: "right", cwd: null });

    expect(res.error).toMatch(/no active terminal cwd/);
  });

  it("returns an error when the glob itself fails", async () => {
    nativeMock.glob.mockRejectedValue(new Error("path does not exist"));

    const res = await run({ left: "/missing", right: "/right" });

    expect(res.error).toMatch(/cannot read \/missing or \/right/);
  });
});
