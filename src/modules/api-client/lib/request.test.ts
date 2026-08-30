import { describe, expect, it } from "vitest";
import { buildHeaders, buildUrl, resolveBody } from "./request";

const vars = { baseUrl: "api.example.com", token: "secret" };

describe("buildUrl", () => {
  it("substitutes variables and appends enabled query params", () => {
    const url = buildUrl(
      "https://{{baseUrl}}/search",
      [
        { id: "1", key: "q", value: "term", enabled: true },
        { id: "2", key: "skip", value: "me", enabled: false },
      ],
      vars,
    );
    expect(url).toBe("https://api.example.com/search?q=term");
  });

  it("appends to an existing query string", () => {
    const url = buildUrl(
      "https://x.example.com/a?b=1",
      [{ id: "1", key: "c", value: "2", enabled: true }],
      {},
    );
    expect(url).toBe("https://x.example.com/a?b=1&c=2");
  });

  it("encodes query values", () => {
    const url = buildUrl(
      "https://x.example.com/",
      [{ id: "1", key: "q", value: "a b&c", enabled: true }],
      {},
    );
    expect(url).toBe("https://x.example.com/?q=a%20b%26c");
  });
});

describe("buildHeaders", () => {
  it("keeps enabled headers and substitutes variables", () => {
    const headers = buildHeaders(
      [
        {
          id: "1",
          key: "Authorization",
          value: "Bearer {{token}}",
          enabled: true,
        },
        { id: "2", key: "X-Disabled", value: "x", enabled: false },
        { id: "3", key: "", value: "y", enabled: true },
      ],
      vars,
    );
    expect(headers).toEqual({ Authorization: "Bearer secret" });
  });
});

describe("resolveBody", () => {
  it("returns null for none mode", () => {
    expect(resolveBody({ bodyMode: "none", body: "ignored" }, vars)).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(resolveBody({ bodyMode: "json", body: "  " }, vars)).toBeNull();
  });

  it("substitutes variables in the body", () => {
    expect(
      resolveBody({ bodyMode: "json", body: '{"t":"{{token}}"}' }, vars),
    ).toBe('{"t":"secret"}');
  });
});
