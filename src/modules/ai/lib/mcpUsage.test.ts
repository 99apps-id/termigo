import { describe, expect, it, beforeEach } from "vitest";
import {
  clearMcpUsage,
  getMcpUsage,
  getMcpUsageForServer,
  recordMcpUsage,
} from "./mcpUsage";

beforeEach(() => clearMcpUsage());

describe("mcpUsage", () => {
  it("counts calls and errors per tool", () => {
    recordMcpUsage("github", "search", true);
    recordMcpUsage("github", "search", false);
    const [entry] = getMcpUsage();
    expect(entry).toMatchObject({
      server: "github",
      tool: "search",
      calls: 2,
      errors: 1,
    });
  });

  it("sorts most-called first and filters by server", () => {
    recordMcpUsage("a", "x", true);
    recordMcpUsage("b", "y", true);
    recordMcpUsage("b", "y", true);
    expect(getMcpUsage().map((e) => e.tool)).toEqual(["y", "x"]);
    expect(getMcpUsageForServer("a").map((e) => e.tool)).toEqual(["x"]);
    expect(getMcpUsageForServer("ghost")).toEqual([]);
  });

  it("never throws from the recorder", () => {
    expect(() => recordMcpUsage("", "", true)).not.toThrow();
  });
});
