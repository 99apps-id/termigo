import { describe, expect, it } from "vitest";

import { applyFilePatch, parseUnifiedDiff } from "./unifiedDiff";

function oneFile(patch: string) {
  const parsed = parseUnifiedDiff(patch);
  expect(parsed.error).toBeUndefined();
  expect(parsed.files).toHaveLength(1);
  return parsed.files[0];
}

describe("parseUnifiedDiff", () => {
  it("parses a single file and hunk", () => {
    const file = oneFile(
      "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n",
    );
    expect(file.oldPath).toBe("foo.ts");
    expect(file.newPath).toBe("foo.ts");
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].oldStart).toBe(1);
    expect(file.hunks[0].lines.map((l) => l.type)).toEqual([
      "context",
      "remove",
      "add",
      "context",
    ]);
  });

  it("reports a malformed patch", () => {
    expect(parseUnifiedDiff("not a patch").error).toBeTruthy();
    expect(
      parseUnifiedDiff("--- a/x\n@@ -1 +1 @@\n-a\n+b\n").error,
    ).toBeTruthy();
  });
});

describe("applyFilePatch", () => {
  it("replaces a line", () => {
    const file = oneFile(
      "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n",
    );
    expect(applyFilePatch("const a = 1;\nconst b = 2;\nconst c = 4;\n", file)).toEqual({
      ok: true,
      content: "const a = 1;\nconst b = 3;\nconst c = 4;\n",
    });
  });

  it("applies several hunks with a shifting offset", () => {
    const file = oneFile(
      "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+A\n@@ -4,1 +4,1 @@\n-d\n+D\n",
    );
    expect(applyFilePatch("a\nb\nc\nd\ne\n", file)).toEqual({
      ok: true,
      content: "A\nb\nc\nD\ne\n",
    });
  });

  it("deletes and inserts lines", () => {
    const del = oneFile("--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n keep\n-gone\n");
    expect(applyFilePatch("keep\ngone\n", del)).toEqual({
      ok: true,
      content: "keep\n",
    });
    const ins = oneFile("--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n a\n+b\n");
    expect(applyFilePatch("a\nc\n", ins)).toEqual({
      ok: true,
      content: "a\nb\nc\n",
    });
  });

  it("fails loudly when the context does not match", () => {
    const file = oneFile(
      "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n",
    );
    const result = applyFilePatch("nothing\nlike\nthis\n", file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not match");
  });

  it("preserves CRLF line endings", () => {
    const file = oneFile("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
    expect(applyFilePatch("a\r\nb\r\n", file)).toEqual({
      ok: true,
      content: "a\r\nB\r\n",
    });
  });

  it("tolerates trailing-whitespace drift in the context", () => {
    const file = oneFile("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
    expect(applyFilePatch("a   \nb\n", file)).toEqual({
      ok: true,
      content: "a   \nB\n",
    });
  });

  it("inserts after the named line for a zero-count hunk", () => {
    const file = oneFile("--- a/f\n+++ b/f\n@@ -1,0 +2,1 @@\n+x\n");
    expect(applyFilePatch("a\nb\n", file)).toEqual({
      ok: true,
      content: "a\nx\nb\n",
    });
  });

  it("does not mistake a removed line beginning with -- for a header", () => {
    const file = oneFile(
      "--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n keep\n--- gone\n",
    );
    expect(applyFilePatch("keep\n-- gone\n", file)).toEqual({
      ok: true,
      content: "keep\n",
    });
  });
});
