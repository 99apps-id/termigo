import { describe, expect, it } from "vitest";

import {
  applyTextEdits,
  collectFileEdits,
  type LspTextEdit,
} from "./workspaceEdit";

function edit(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string,
): LspTextEdit {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    newText,
  };
}

describe("applyTextEdits", () => {
  it("renames every occurrence on a line regardless of edit order", () => {
    const content = "const foo = foo + 1;\n";
    const edits = [
      edit(0, 12, 0, 15, "bar"),
      edit(0, 6, 0, 9, "bar"),
    ];
    expect(applyTextEdits(content, edits)).toBe("const bar = bar + 1;\n");
  });

  it("replaces across lines", () => {
    const content = "a\nb\nc\n";
    expect(applyTextEdits(content, [edit(1, 0, 2, 0, "B\n")])).toBe(
      "a\nB\nc\n",
    );
  });

  it("splices at end of file", () => {
    const content = "abc";
    expect(applyTextEdits(content, [edit(0, 3, 0, 3, "def")])).toBe("abcdef");
  });

  it("keeps the later edit when two overlap", () => {
    const content = "abcdef\n";
    const edits = [edit(0, 0, 0, 3, "X"), edit(0, 2, 0, 5, "Y")];
    expect(applyTextEdits(content, edits)).toBe("abYf\n");
  });

  it("returns content unchanged for an empty edit list", () => {
    expect(applyTextEdits("abc", [])).toBe("abc");
  });
});

describe("collectFileEdits", () => {
  it("reads both the changes map and documentChanges, merged per file", () => {
    const plans = collectFileEdits({
      changes: {
        "file:///C:/proj/a.ts": [edit(0, 0, 0, 1, "x")],
      },
      documentChanges: [
        {
          textDocument: { uri: "file:///C:/proj/a.ts" },
          edits: [edit(1, 0, 1, 1, "y")],
        },
        {
          textDocument: { uri: "file:///C:/proj/b.ts" },
          edits: [edit(0, 0, 0, 1, "z")],
        },
        { kind: "delete" },
      ],
    });
    expect(plans).toHaveLength(2);
    const a = plans.find((p) => p.path.endsWith("a.ts"));
    const b = plans.find((p) => p.path.endsWith("b.ts"));
    expect(a?.edits).toHaveLength(2);
    expect(b?.edits).toHaveLength(1);
  });

  it("ignores non-file URIs and empty edit lists", () => {
    const plans = collectFileEdits({
      changes: {
        "untitled:Untitled-1": [edit(0, 0, 0, 1, "x")],
        "file:///C:/proj/c.ts": [],
      },
    });
    expect(plans).toHaveLength(0);
  });
});
