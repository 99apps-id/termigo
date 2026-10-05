import { describe, expect, it } from "vitest";
import { createUnifiedWebFetchTool, isLoopbackTarget } from "./fetch";

describe("isLoopbackTarget", () => {
  it("identifies localhost and IPv4/IPv6 loopback targets", () => {
    expect(isLoopbackTarget("http://localhost:3000/")).toBe(true);
    expect(isLoopbackTarget("http://127.0.0.1:8080/api")).toBe(true);
    expect(isLoopbackTarget("http://127.0.0.2:5173/")).toBe(true);
    expect(isLoopbackTarget("http://[::1]:3000/")).toBe(true);
  });

  it("rejects public domains and cloud metadata addresses", () => {
    expect(isLoopbackTarget("https://google.com/")).toBe(false);
    expect(isLoopbackTarget("https://github.com/")).toBe(false);
    expect(isLoopbackTarget("http://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
    expect(isLoopbackTarget("http://192.168.1.1/admin")).toBe(false);
    expect(isLoopbackTarget("http://10.0.0.1/")).toBe(false);
  });

  it("handles malformed URLs safely", () => {
    expect(isLoopbackTarget("not a valid url")).toBe(false);
    expect(isLoopbackTarget("")).toBe(false);
  });
});

describe("createUnifiedWebFetchTool", () => {
  it("creates a tool with the expected schema and approval flag", () => {
    const fetchTool = createUnifiedWebFetchTool();
    expect(fetchTool).toBeDefined();
    expect(fetchTool.description).toContain("Fetch a URL over HTTP(S)");
    expect(
      (fetchTool as unknown as { needsApproval?: boolean }).needsApproval,
    ).toBe(true);

    const schema = fetchTool.inputSchema as unknown as {
      parse: (input: unknown) => {
        url: string;
        raw?: boolean;
        use_reader?: boolean;
      };
    };
    const parsed = schema.parse({
      url: "http://localhost:3000/docs",
      raw: true,
      use_reader: false,
    });
    expect(parsed.url).toBe("http://localhost:3000/docs");
    expect(parsed.raw).toBe(true);
    expect(parsed.use_reader).toBe(false);
  });
});
