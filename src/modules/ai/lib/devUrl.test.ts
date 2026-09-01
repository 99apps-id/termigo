import { describe, expect, it } from "vitest";
import {
  containsSchemeSeparator,
  findLocalUrl,
  loopbackHost,
  stripTrailingPunct,
} from "./devUrl";

describe("findLocalUrl", () => {
  it("finds a plain localhost url", () => {
    expect(
      findLocalUrl("  VITE v5  ready in 300 ms  http://localhost:5173/"),
    ).toBe("http://localhost:5173/");
  });

  it("strips ANSI colour/style escapes that split the port off (Vite bold)", () => {
    const raw = "  Local:   http://localhost:\u001b[1m5173\u001b[22m/\r\n";
    expect(findLocalUrl(raw)).toBe("http://localhost:5173/");
  });

  it("returns null when there is no url", () => {
    expect(findLocalUrl("compiled successfully in 1.2s")).toBeNull();
  });

  it("returns the LAST url when a server reprints its banner", () => {
    const text = "http://localhost:3000  → restarted →  http://localhost:3001";
    expect(findLocalUrl(text)).toBe("http://localhost:3001");
  });

  it("rewrites 0.0.0.0 to 127.0.0.1 (bind address, not connect)", () => {
    expect(findLocalUrl("Serving at http://0.0.0.0:9000")).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("strips trailing punctuation from a url", () => {
    expect(findLocalUrl("Visit http://localhost:8000/admin]. now")).toBe(
      "http://localhost:8000/admin",
    );
  });

  it("accepts 127.0.0.1 directly", () => {
    expect(findLocalUrl("uWS serving at http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("finds an IPv6 loopback url", () => {
    expect(findLocalUrl("Server listening on http://[::1]:3000/")).toBe(
      "http://[::1]:3000/",
    );
  });

  it("keeps a path prefix", () => {
    expect(findLocalUrl("   ➜  Local:  http://localhost:1420/")).toBe(
      "http://localhost:1420/",
    );
  });
});

describe("stripTrailingPunct", () => {
  it("removes trailing separators", () => {
    expect(stripTrailingPunct("http://localhost:1/x].")).toBe(
      "http://localhost:1/x",
    );
  });
});

describe("loopbackHost", () => {
  it("rewrites only a leading 0.0.0.0 host", () => {
    expect(loopbackHost("http://0.0.0.0:9000/")).toBe("http://127.0.0.1:9000/");
    expect(loopbackHost("http://0.0.0.0")).toBe("http://127.0.0.1");
    expect(loopbackHost("http://localhost:1")).toBe("http://localhost:1");
  });
});

describe("containsSchemeSeparator", () => {
  it("detects `://` in raw bytes", () => {
    expect(containsSchemeSeparator(new TextEncoder().encode("a://b"))).toBe(
      true,
    );
    expect(containsSchemeSeparator(new TextEncoder().encode("nope"))).toBe(
      false,
    );
  });
});
