import { describe, expect, it } from "vitest";
import { parseCurl } from "./curl";

/** Assert a request parsed and narrow the type so tests avoid `!`. */
function curl(input: string) {
  const req = parseCurl(input);
  if (!req) throw new Error(`expected a parsed request from: ${input}`);
  return req;
}

describe("parseCurl", () => {
  it("parses a simple GET", () => {
    const req = curl("curl https://api.example.com/users");
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.example.com/users");
  });

  it("parses method and headers", () => {
    const req = curl(
      `curl -X POST https://api.example.com/items -H "Content-Type: application/json" -H "x-key: abc"`,
    );
    expect(req.method).toBe("POST");
    expect(req.bodyMode).toBe("json");
    const header = req.headers.find((h) => h.key === "x-key");
    expect(header?.value).toBe("abc");
  });

  it("parses a JSON body", () => {
    const req = curl(
      `curl -d '{"name":"alice"}' https://api.example.com/items`,
    );
    expect(req.body).toBe('{"name":"alice"}');
    expect(req.bodyMode).toBe("json");
  });

  it("supports basic auth via -u", () => {
    const req = curl(`curl -u alice:secret https://api.example.com/`);
    const auth = req.headers.find((h) => h.key === "Authorization");
    expect(auth?.value).toMatch(/^Basic /);
  });

  it("returns null for non-curl input", () => {
    expect(parseCurl("not a curl command")).toBeNull();
  });

  it("tolerates unknown flags", () => {
    const req = curl(
      `curl --compressed --insecure https://api.example.com/ping`,
    );
    expect(req.url).toBe("https://api.example.com/ping");
  });
});
