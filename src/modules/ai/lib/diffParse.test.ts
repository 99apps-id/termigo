import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, reverseApplyHunk } from "./diffParse";

const SAMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { run } from "./run";
 
-export const old = true;
+export const next = true;
+export const extra = 1;
 
diff --git a/README.md b/README.md
index aaa..bbb 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Termigo
+New line
 End
`;

describe("parseUnifiedDiff", () => {
  it("splits multiple files into separate entries", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    expect(files).toHaveLength(2);
    expect(files[0].filePath).toBe("src/app.ts");
    expect(files[1].filePath).toBe("README.md");
  });

  it("classifies lines by their prefix", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const hunk = files[0].hunks[0];
    expect(hunk.header).toMatch(/^@@ -1,4 \+1,5 @@/);
    const types = hunk.lines.map((l) => l.type);
    expect(types).toEqual([
      "context",
      "context",
      "del",
      "add",
      "add",
      "context",
    ]);
    expect(hunk.lines[2].content).toBe("export const old = true;");
    expect(hunk.lines[3].content).toBe("export const next = true;");
  });

  it("keeps hunk status pending and gives unique ids", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const ids = files.flatMap((f) => f.hunks.map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of files) {
      for (const h of f.hunks) expect(h.status).toBe("pending");
    }
  });

  it("skips files without hunks", () => {
    const metaOnly = `diff --git a/x b/x
new file mode 100644
index 0000000..1111111
`;
    expect(parseUnifiedDiff(metaOnly)).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const crlf = SAMPLE_DIFF.replace(/\n/g, "\r\n");
    const files = parseUnifiedDiff(crlf);
    expect(files).toHaveLength(2);
    expect(files[0].hunks[0].lines[2].content).toBe("export const old = true;");
  });
});

describe("reverseApplyHunk", () => {
  const hunk = parseUnifiedDiff(SAMPLE_DIFF)[0].hunks[0];

  it("restores the original content", () => {
    const current = [
      'import { run } from "./run";',
      "",
      "export const next = true;",
      "export const extra = 1;",
      "",
    ].join("\n");
    const expected = [
      'import { run } from "./run";',
      "",
      "export const old = true;",
      "",
    ].join("\n");
    expect(reverseApplyHunk(current, hunk)).toBe(expected);
  });

  it("returns null when the hunk does not match", () => {
    expect(reverseApplyHunk("totally different content", hunk)).toBeNull();
  });
});
