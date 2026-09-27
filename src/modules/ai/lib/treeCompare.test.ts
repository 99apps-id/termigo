import { describe, expect, it } from "vitest";
import { diffTrees, filterByRel, type TreeFile } from "./treeCompare";

const file = (rel: string, size: number, mtime: number): TreeFile => ({
  rel,
  path: `/tree/${rel}`,
  size,
  mtime,
});

describe("diffTrees", () => {
  it("separates files present on only one side", () => {
    const diff = diffTrees(
      [file("a.ts", 10, 1), file("shared.ts", 20, 5)],
      [file("shared.ts", 20, 5), file("b.ts", 30, 7)],
    );

    expect(diff.onlyInLeft.map((f) => f.rel)).toEqual(["a.ts"]);
    expect(diff.onlyInRight.map((f) => f.rel)).toEqual(["b.ts"]);
    expect(diff.changed).toEqual([]);
    expect(diff.identical).toBe(1);
  });

  it("reports a file with the same path but a different size or mtime as changed", () => {
    const diff = diffTrees(
      [file("edited.ts", 10, 1), file("touched.ts", 10, 1)],
      [file("edited.ts", 99, 1), file("touched.ts", 10, 2)],
    );

    expect(diff.changed.map((c) => c.left.rel)).toEqual([
      "edited.ts",
      "touched.ts",
    ]);
    expect(diff.onlyInLeft).toEqual([]);
    expect(diff.onlyInRight).toEqual([]);
    expect(diff.identical).toBe(0);
  });

  it("keys on the tree-relative path, so two roots line up", () => {
    const diff = diffTrees(
      [{ rel: "src/main.ts", path: "/left/src/main.ts", size: 5, mtime: 1 }],
      [{ rel: "src/main.ts", path: "/right/src/main.ts", size: 5, mtime: 1 }],
    );

    expect(diff.identical).toBe(1);
    expect(diff.onlyInLeft).toEqual([]);
    expect(diff.onlyInRight).toEqual([]);
  });

  it("sorts every category by path so a report is reproducible", () => {
    const diff = diffTrees([file("z.ts", 1, 1), file("a.ts", 1, 1)], []);
    expect(diff.onlyInLeft.map((f) => f.rel)).toEqual(["a.ts", "z.ts"]);
  });
});

describe("filterByRel", () => {
  it("matches case-insensitively on any path segment", () => {
    const files = [
      file("src-tauri/src/main.rs", 1, 1),
      file("src/app.ts", 1, 1),
    ];

    expect(filterByRel(files, "SRC-TAURI").map((f) => f.rel)).toEqual([
      "src-tauri/src/main.rs",
    ]);
    expect(filterByRel(files, "app").map((f) => f.rel)).toEqual(["src/app.ts"]);
    expect(filterByRel(files, "nothing")).toEqual([]);
  });
});
