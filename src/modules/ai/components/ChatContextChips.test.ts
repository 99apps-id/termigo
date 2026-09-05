import { describe, expect, it } from "vitest";
import { stripUserContextBlocks } from "./ChatContextChips";

describe("stripUserContextBlocks", () => {
  it("extracts terminal selection chips and cleans text", () => {
    const raw = `<selection source="terminal">
line 1
line 2
line 3
</selection>
Explain this error`;

    const { text, chips } = stripUserContextBlocks(raw);
    expect(text).toBe("Explain this error");
    expect(chips).toEqual([
      {
        kind: "selection",
        source: "terminal",
        lines: 3,
      },
    ]);
  });

  it("extracts editor selection and file chips", () => {
    const raw = `<file name="src/index.ts">
const a = 1;
</file>
<selection source="editor">
let b = 2;
</selection>
Refactor this code`;

    const { text, chips } = stripUserContextBlocks(raw);
    expect(text).toBe("Refactor this code");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toEqual({
      kind: "file",
      name: "src/index.ts",
      lines: 1,
    });
    expect(chips[1]).toEqual({
      kind: "selection",
      source: "editor",
      lines: 1,
    });
  });

  it("extracts snippet chips", () => {
    const raw = `<snippet name="git-status">
On branch main
</snippet>
What does this mean?`;

    const { text, chips } = stripUserContextBlocks(raw);
    expect(text).toBe("What does this mean?");
    expect(chips).toEqual([
      {
        kind: "snippet",
        name: "git-status",
      },
    ]);
  });

  it("returns plain text unchanged when no context tags are present", () => {
    const raw = "Hello, can you help me?";
    const { text, chips } = stripUserContextBlocks(raw);
    expect(text).toBe(raw);
    expect(chips).toEqual([]);
  });
});
