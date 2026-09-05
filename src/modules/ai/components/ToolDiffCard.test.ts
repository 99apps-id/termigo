import { describe, expect, it } from "vitest";
import { computeLineDiff, extractPathFromInput } from "./ToolDiffCard";

describe("computeLineDiff", () => {
  it("handles empty strings", () => {
    const r = computeLineDiff("", "");
    expect(r.lines).toEqual([]);
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
  });

  it("handles newly created files as additions", () => {
    const r = computeLineDiff("", "line 1\nline 2\nline 3");
    expect(r.additions).toBe(3);
    expect(r.deletions).toBe(0);
    expect(r.lines.every((l) => l.type === "add")).toBe(true);
    expect(r.lines[0].newLineNumber).toBe(1);
    expect(r.lines[2].newLineNumber).toBe(3);
  });

  it("handles deleted files as deletions", () => {
    const r = computeLineDiff("line 1\nline 2", "");
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(2);
    expect(r.lines.every((l) => l.type === "del")).toBe(true);
    expect(r.lines[0].oldLineNumber).toBe(1);
    expect(r.lines[1].oldLineNumber).toBe(2);
  });

  it("identifies modifications with context lines", () => {
    const oldCode = [
      "import React from 'react';",
      "export function Button() {",
      "  return <button>Old</button>;",
      "}",
      "export default Button;",
    ].join("\n");

    const newCode = [
      "import React from 'react';",
      "export function Button() {",
      "  return <button>New</button>;",
      "}",
      "export default Button;",
    ].join("\n");

    const r = computeLineDiff(oldCode, newCode);
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);

    const adds = r.lines.filter((l) => l.type === "add");
    const dels = r.lines.filter((l) => l.type === "del");
    const ctx = r.lines.filter((l) => l.type === "context");

    expect(adds[0].text).toContain("New");
    expect(dels[0].text).toContain("Old");
    expect(ctx.length).toBeGreaterThanOrEqual(2);
  });

  it("correctly counts multiple additions and deletions", () => {
    const oldCode = "a\nb\nc\nd";
    const newCode = "a\nx\ny\nz\nd";
    const r = computeLineDiff(oldCode, newCode);
    expect(r.deletions).toBe(2); // b, c
    expect(r.additions).toBe(3); // x, y, z
  });
});

describe("extractPathFromInput", () => {
  it("recovers path from standard path key", () => {
    expect(extractPathFromInput({ path: "src/App.tsx" })).toBe("src/App.tsx");
  });

  it("recovers path from alias keys", () => {
    expect(extractPathFromInput({ file_path: "src/index.ts" })).toBe(
      "src/index.ts",
    );
    expect(extractPathFromInput({ filepath: "src/utils.ts" })).toBe(
      "src/utils.ts",
    );
    expect(extractPathFromInput({ target: "Cargo.toml" })).toBe("Cargo.toml");
    expect(extractPathFromInput({ target_path: "package.json" })).toBe(
      "package.json",
    );
    expect(extractPathFromInput({ filename: "README.md" })).toBe("README.md");
    expect(extractPathFromInput({ file: "main.rs" })).toBe("main.rs");
  });

  it("handles null, undefined, and non-objects safely", () => {
    expect(extractPathFromInput(null)).toBeNull();
    expect(extractPathFromInput(undefined)).toBeNull();
    expect(extractPathFromInput("string")).toBeNull();
    expect(extractPathFromInput({})).toBeNull();
  });
});
