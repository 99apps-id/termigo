import { describe, expect, it } from "vitest";
import { extractMermaidBlocks } from "./mermaidImage";

describe("extractMermaidBlocks", () => {
  it("returns no blocks when there is no mermaid fence", () => {
    expect(extractMermaidBlocks("Just plain text.")).toEqual([]);
    expect(extractMermaidBlocks("```js\nconst x = 1;\n```")).toEqual([]);
  });

  it("extracts a single mermaid block", () => {
    const code = "graph TD\n  A --> B";
    const text = `Here is the flow:\n\`\`\`mermaid\n${code}\n\`\`\`\nThanks!`;
    expect(extractMermaidBlocks(text)).toEqual([code]);
  });

  it("extracts multiple blocks in order", () => {
    const a = "graph TD\n  A --> B";
    const b = "sequenceDiagram\n  Alice->>Bob: hi";
    const text = `\`\`\`mermaid\n${a}\n\`\`\`\nnext\n\`\`\`mermaid\n${b}\n\`\`\``;
    expect(extractMermaidBlocks(text)).toEqual([a, b]);
  });

  it("trims surrounding whitespace and drops empty fences", () => {
    const text =
      "```mermaid\n\n  graph LR\n  X --> Y  \n```\n```mermaid\n\n```";
    expect(extractMermaidBlocks(text)).toEqual(["graph LR\n  X --> Y"]);
  });

  it("tolerates a code fence without a trailing newline", () => {
    const text = "```mermaid\ngraph TD\n  A --> B```";
    expect(extractMermaidBlocks(text).length).toBeGreaterThan(0);
  });
});
