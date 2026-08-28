import { describe, expect, it } from "vitest";

import { markdownCodeText, parseFileRef } from "./markdown-code";

describe("markdownCodeText", () => {
  it("preserves text nested inside React children for HTML-wrapped code blocks", async () => {
    const React = await import("react");

    const text = markdownCodeText([
      "\n",
      React.createElement("span", { key: "a" }, 'const client = createClient("");'),
      "\n",
      React.createElement("span", { key: "b" }, 'await client.send({ id: "example" });'),
      "\n",
    ]);

    expect(text).toBe(
      '\nconst client = createClient("");\nawait client.send({ id: "example" });\n',
    );
  });
});

describe("parseFileRef", () => {
  it("recognises file references, with and without a line", () => {
    expect(parseFileRef("src/app/App.tsx:42")).toEqual({
      path: "src/app/App.tsx",
      line: 42,
    });
    expect(parseFileRef("App.tsx")).toEqual({ path: "App.tsx", line: 1 });
    expect(parseFileRef("README.md")).toEqual({ path: "README.md", line: 1 });
    // A path separator makes any extension count, even an unknown one.
    expect(parseFileRef("src/data/table.parquet")).toEqual({
      path: "src/data/table.parquet",
      line: 1,
    });
    // Column is tolerated but ignored (we navigate by line).
    expect(parseFileRef("lib/foo.rs:12:5")).toEqual({
      path: "lib/foo.rs",
      line: 12,
    });
  });

  it("does not mistake code member access or prose for a file", () => {
    expect(parseFileRef("array.map")).toBeNull();
    expect(parseFileRef("obj.length")).toBeNull();
    expect(parseFileRef("npm run build")).toBeNull();
    expect(parseFileRef("useState")).toBeNull();
    expect(parseFileRef("https://example.com/a.js")).toBeNull();
    expect(parseFileRef("1.2")).toBeNull();
  });
});
