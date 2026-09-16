import { beforeEach, describe, expect, it } from "vitest";
import {
  buildArtifactTools,
  getArtifact,
  listArtifacts,
  MAX_ARTIFACTS,
  putArtifact,
  resetArtifacts,
  sliceLines,
} from "./artifacts";

const tools = buildArtifactTools();

async function write(content: string, label?: string) {
  const execute = tools.artifact_write.execute;
  if (!execute) throw new Error("artifact_write has no execute");
  return (await execute(
    { content, ...(label ? { label } : {}) },
    {} as never,
  )) as {
    id: string;
    label: string;
    bytes: number;
    lines: number;
  };
}

async function read(id: string, offset?: number, limit?: number) {
  const execute = tools.artifact_read.execute;
  if (!execute) throw new Error("artifact_read has no execute");
  return (await execute(
    {
      id,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    {} as never,
  )) as {
    id?: string;
    error?: string;
    text?: string;
    offset?: number;
    limit?: number;
    totalLines?: number;
    truncated?: boolean;
  };
}

beforeEach(() => {
  resetArtifacts();
});

describe("artifact store", () => {
  it("stores content out of context and returns a handle", async () => {
    const a = await write("line1\nline2\nline3", "build log");
    expect(a.id).toMatch(/^art-/);
    expect(a.label).toBe("build log");
    expect(a.lines).toBe(3);
    expect(a.bytes).toBeGreaterThan(0);
    expect(getArtifact(a.id)?.content).toBe("line1\nline2\nline3");
  });

  it("counts a trailing-newline-free blob and its true line count", () => {
    expect(putArtifact("a\nb").lines).toBe(2);
    expect(putArtifact("").lines).toBe(0);
    expect(putArtifact("single").lines).toBe(1);
  });

  it("reads back only the requested line window", async () => {
    const a = await write("l0\nl1\nl2\nl3\nl4");
    const slice = await read(a.id, 1, 2);
    expect(slice.text).toBe("l1\nl2");
    expect(slice.offset).toBe(1);
    expect(slice.limit).toBe(2);
    expect(slice.totalLines).toBe(5);
    expect(slice.truncated).toBe(true);
  });

  it("defaults to the top of the artifact", async () => {
    const a = await write("l0\nl1\nl2");
    const slice = await read(a.id);
    expect(slice.offset).toBe(0);
    expect(slice.text).toBe("l0\nl1\nl2");
    expect(slice.truncated).toBe(false);
  });

  it("clamps a window past the end instead of erroring", async () => {
    const a = await write("l0\nl1");
    const slice = await read(a.id, 10, 5);
    expect(slice.text).toBe("");
    expect(slice.truncated).toBe(false);
  });

  it("refuses an unknown id with a usable message", async () => {
    const slice = await read("art-nope");
    expect(slice.error).toContain("unknown artifact id");
    expect(slice.text).toBeUndefined();
  });

  it("lists what is stored, oldest first", async () => {
    const a = await write("one", "first");
    const b = await write("two", "second");
    const execute = tools.artifact_list.execute;
    if (!execute) throw new Error("artifact_list has no execute");
    const out = (await execute({}, {} as never)) as {
      count: number;
      artifacts: { id: string; label: string }[];
    };
    expect(out.count).toBe(2);
    expect(out.artifacts.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(out.artifacts.map((x) => x.label)).toEqual(["first", "second"]);
  });

  it("keeps the heap bounded by evicting the oldest artifact", async () => {
    const first = await write("oldest");
    for (let i = 0; i < MAX_ARTIFACTS; i++) await write(`filler-${i}`);
    // One past the cap: the first write must be gone, the newest retained.
    expect(listArtifacts().length).toBe(MAX_ARTIFACTS);
    expect(getArtifact(first.id)).toBeUndefined();
  });

  it("still returns an oversized single artifact rather than silently dropping it", async () => {
    const a = await write("x".repeat(2 * 1024 * 1024 + 1));
    expect(getArtifact(a.id)).toBeDefined();
  });
});

describe("sliceLines", () => {
  it("slices by half-open line range", () => {
    expect(sliceLines("a\nb\nc\nd", 1, 2)).toEqual({
      text: "b\nc",
      start: 1,
      end: 3,
      total: 4,
    });
  });

  it("never returns a negative start", () => {
    expect(sliceLines("a\nb", -5, 1).start).toBe(0);
  });
});
