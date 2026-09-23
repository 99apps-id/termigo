import { describe, expect, it } from "vitest";
import { parseAnsiText } from "./AnsiOutput";

describe("parseAnsiText", () => {
  it("handles plain text without ansi escapes", () => {
    const spans = parseAnsiText("hello world");
    expect(spans).toEqual([{ text: "hello world" }]);
  });

  it("handles empty string", () => {
    expect(parseAnsiText("")).toEqual([]);
  });

  it("parses foreground standard colors", () => {
    const raw = "normal \u001b[31mred\u001b[0m normal";
    const spans = parseAnsiText(raw);
    expect(spans).toHaveLength(3);
    expect(spans[0]).toEqual({ text: "normal " });
    expect(spans[1]).toMatchObject({
      text: "red",
      color: "var(--terminal-ansi-red)",
    });
    expect(spans[2]).toEqual({ text: " normal" });
  });

  it("parses bright foreground colors", () => {
    const raw = "\u001b[92mbright green\u001b[39m";
    const spans = parseAnsiText(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      text: "bright green",
      color: "var(--terminal-ansi-bright-green)",
    });
  });

  it("parses background colors", () => {
    const raw = "\u001b[44mblue bg\u001b[49m";
    const spans = parseAnsiText(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      text: "blue bg",
      bgColor: "var(--terminal-ansi-blue)",
    });
  });

  it("parses bold, italic, and underline styling", () => {
    const raw = "\u001b[1;3;4mcombo\u001b[0m";
    const spans = parseAnsiText(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      text: "combo",
      bold: true,
      italic: true,
      underline: true,
    });
  });

  it("parses 256 color codes", () => {
    // 38;5;1 is red
    const raw = "\u001b[38;5;1mcolor1\u001b[0m";
    const spans = parseAnsiText(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0].color).toBe("var(--terminal-ansi-red)");
  });

  it("parses 24-bit RGB truecolor", () => {
    const raw = "\u001b[38;2;100;150;200mrgb color\u001b[0m";
    const spans = parseAnsiText(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0].color).toBe("rgb(100, 150, 200)");
  });

  it("strips non-SGR escape sequences like cursor moves", () => {
    const raw = "step 1\u001b[2K\rstep 2\u001b[1A";
    const spans = parseAnsiText(raw);
    const combined = spans.map((s) => s.text).join("");
    expect(combined).not.toContain("\u001b[2K");
    expect(combined).not.toContain("\u001b[1A");
  });
});
