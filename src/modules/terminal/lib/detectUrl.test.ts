import { describe, expect, it } from "vitest";
import {
  containsSchemeSeparator,
  findLocalUrl,
  stripTrailingPunct,
} from "./detectUrl";

const enc = (s: string) => new TextEncoder().encode(s);

describe("containsSchemeSeparator", () => {
  it("gates on ://", () => {
    expect(containsSchemeSeparator(enc("Local: http://localhost:5173/"))).toBe(
      true,
    );
    expect(containsSchemeSeparator(enc("just some text"))).toBe(false);
  });
});

describe("findLocalUrl", () => {
  it("pulls a plain localhost url", () => {
    expect(findLocalUrl("  ➜  Local:   http://localhost:5173/")).toBe(
      "http://localhost:5173/",
    );
  });

  it("survives the bold-port ANSI escape vite prints", () => {
    expect(findLocalUrl("http://localhost:\x1b[1m5173\x1b[22m/")).toBe(
      "http://localhost:5173/",
    );
  });

  it("rewrites the 0.0.0.0 bind address to loopback", () => {
    expect(findLocalUrl("Listening on http://0.0.0.0:8000")).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("returns the last url when a banner reprints", () => {
    expect(
      findLocalUrl("http://localhost:3000\nrestarted http://localhost:3001"),
    ).toBe("http://localhost:3001");
  });

  it("strips trailing punctuation", () => {
    expect(findLocalUrl("open (http://localhost:9000/admin).")).toBe(
      "http://localhost:9000/admin",
    );
  });

  it("ignores a non-loopback url", () => {
    expect(findLocalUrl("see https://example.com/docs")).toBeNull();
  });

  it("returns null when there is no url", () => {
    expect(findLocalUrl("compiled successfully")).toBeNull();
  });
});

describe("stripTrailingPunct", () => {
  it("trims trailing brackets and dots", () => {
    expect(stripTrailingPunct("http://localhost:8000/x].")).toBe(
      "http://localhost:8000/x",
    );
  });
});
