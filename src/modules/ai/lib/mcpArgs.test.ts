import { describe, expect, it } from "vitest";
import { formatEnvLines, parseCommandLine, parseEnvLines } from "./mcpArgs";

describe("parseCommandLine", () => {
  it("reads the shape every MCP server is documented as", () => {
    expect(parseCommandLine("npx -y @modelcontextprotocol/server-github")).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("collapses the whitespace people leave behind", () => {
    expect(parseCommandLine("  npx   -y   wigolo  ")).toEqual({
      command: "npx",
      args: ["-y", "wigolo"],
    });
  });

  // A naive split would turn one path into two arguments without saying so.
  it("keeps a quoted argument whole", () => {
    expect(parseCommandLine('node "C:/My Tools/server.js" --port 3000')).toEqual({
      command: "node",
      args: ["C:/My Tools/server.js", "--port", "3000"],
    });
    expect(parseCommandLine("sh -c 'echo hi there'")).toEqual({
      command: "sh",
      args: ["-c", "echo hi there"],
    });
  });

  it("handles a bare command", () => {
    expect(parseCommandLine("my-server")).toEqual({ command: "my-server", args: [] });
  });

  it("returns an empty command for empty input rather than throwing", () => {
    expect(parseCommandLine("   ")).toEqual({ command: "", args: [] });
  });
});

describe("parseEnvLines", () => {
  it("reads one variable per line", () => {
    expect(parseEnvLines("GITHUB_TOKEN=abc\nDEBUG=1")).toEqual({
      GITHUB_TOKEN: "abc",
      DEBUG: "1",
    });
  });

  // Tokens and URLs contain `=` routinely; splitting on every one would
  // truncate them all.
  it("splits on the first equals only", () => {
    expect(parseEnvLines("URL=https://x.dev/?a=1&b=2")).toEqual({
      URL: "https://x.dev/?a=1&b=2",
    });
    expect(parseEnvLines("KEY=abc=def==")).toEqual({ KEY: "abc=def==" });
  });

  it("skips blanks and comments", () => {
    expect(parseEnvLines("\n# a note\nA=1\n\n")).toEqual({ A: "1" });
  });

  it("ignores a line that is not a variable at all", () => {
    expect(parseEnvLines("just some text\n=novalue\n1BAD=x")).toEqual({});
  });

  it("accepts an empty value, which is different from unset", () => {
    expect(parseEnvLines("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("round-trips through the form", () => {
    const env = { A: "1", B: "two words" };
    expect(parseEnvLines(formatEnvLines(env))).toEqual(env);
  });
});
