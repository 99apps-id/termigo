import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/mcp/bridge", () => ({
  mcpListServers: (...a: unknown[]) => listServers(...a),
  mcpListTools: (...a: unknown[]) => listTools(...a),
  mcpCallTool: (...a: unknown[]) => callTool(...a),
}));

const listServers = vi.fn();
const listTools = vi.fn();
const callTool = vi.fn();

import {
  describeMcpTool,
  getMcpTools,
  invalidateMcpTools,
  isMcpTool,
  loadMcpTools,
  MCP_CACHE_MS,
  mcpToolName,
  parseMcpToolName,
  toolSchema,
} from "./mcpTools";

const objectSchema = { type: "object", properties: { q: { type: "string" } } };

describe("tool names", () => {
  it("round-trips a server and tool name", () => {
    const name = mcpToolName("github", "create_issue");
    expect(isMcpTool(name)).toBe(true);
    expect(parseMcpToolName(name)).toEqual({
      server: "github",
      tool: "create_issue",
    });
  });

  // Server names contain underscores in practice, so splitting on the first
  // `__` would attribute the tool to the wrong server.
  it("splits on the last separator, not the first", () => {
    expect(parseMcpToolName("mcp__my_server__read_file")).toEqual({
      server: "my_server",
      tool: "read_file",
    });
  });

  it("refuses names that are not MCP tools", () => {
    for (const n of ["read_file", "mcp__", "mcp__onlyserver", ""]) {
      expect(parseMcpToolName(n)).toBeNull();
    }
    expect(isMcpTool("write_file")).toBe(false);
  });
});

describe("toolSchema", () => {
  it("passes a usable object schema straight through", () => {
    expect(toolSchema(objectSchema)).toBe(objectSchema);
  });

  // Third-party servers send all sorts of things. A bad schema must not read
  // as a bug in Termigo, so it degrades instead of failing the run.
  it("falls back to an open object for anything unusable", () => {
    for (const bad of [undefined, null, "nope", 42, { type: "string" }, {}]) {
      expect(toolSchema(bad)).toEqual({
        type: "object",
        properties: {},
        additionalProperties: true,
      });
    }
  });
});

describe("describeMcpTool", () => {
  it("names the server, since the model sees many at once", () => {
    const d = describeMcpTool("github", {
      name: "create_issue",
      description: "Open an issue.",
      inputSchema: objectSchema,
    });
    expect(d).toContain("Open an issue.");
    expect(d).toContain('"github"');
  });

  it("still says something when the server gave no description", () => {
    const d = describeMcpTool("db", {
      name: "query",
      description: "",
      inputSchema: objectSchema,
    });
    expect(d).toContain("query");
    expect(d).toContain('"db"');
  });
});

describe("loadMcpTools", () => {
  function server(name: string) {
    return { name, command: "x", args: [], env: {}, scope: "user", cwd: null };
  }

  it("builds one prefixed tool per server tool", async () => {
    listServers.mockResolvedValue([server("github")]);
    listTools.mockResolvedValue({
      server: "github",
      tools: [{ name: "create_issue", description: "d", inputSchema: objectSchema }],
    });

    const tools = await loadMcpTools("/ws");
    expect(Object.keys(tools)).toEqual(["mcp__github__create_issue"]);
  });

  // MCP servers are child processes and any one of them can fail to start.
  it("keeps the healthy servers when one fails to list", async () => {
    listServers.mockResolvedValue([server("good"), server("broken")]);
    listTools.mockImplementation(async (name: string) => {
      if (name === "broken") throw new Error("spawn ENOENT");
      return {
        server: "good",
        tools: [{ name: "ping", description: "d", inputSchema: objectSchema }],
      };
    });

    const tools = await loadMcpTools("/ws");
    expect(Object.keys(tools)).toEqual(["mcp__good__ping"]);
  });

  it("contributes nothing when the registry cannot be read", async () => {
    listServers.mockRejectedValue(new Error("no such file"));
    expect(await loadMcpTools("/ws")).toEqual({});
  });

  it("requires approval for every tool it builds", async () => {
    listServers.mockResolvedValue([server("s")]);
    listTools.mockResolvedValue({
      server: "s",
      tools: [{ name: "t", description: "d", inputSchema: objectSchema }],
    });

    const tools = await loadMcpTools("/ws");
    expect(tools.mcp__s__t.needsApproval).toBe(true);
  });

  // A failing call must not collapse the run; the model should see the error
  // and choose another route.
  it("returns a call failure to the model instead of throwing", async () => {
    listServers.mockResolvedValue([server("s")]);
    listTools.mockResolvedValue({
      server: "s",
      tools: [{ name: "t", description: "d", inputSchema: objectSchema }],
    });
    callTool.mockRejectedValue(new Error("server died"));

    const tools = await loadMcpTools("/ws");
    const exec = tools.mcp__s__t.execute as (
      a: unknown,
      o: unknown,
    ) => Promise<unknown>;
    const result = await exec({}, {});
    expect(result).toMatchObject({ server: "s", tool: "t" });
    expect(String((result as { error: string }).error)).toContain("server died");
  });
});

describe("getMcpTools caching", () => {
  it("does not respawn every server on each message", async () => {
    invalidateMcpTools();
    listServers.mockClear();
    listServers.mockResolvedValue([]);
    listTools.mockResolvedValue({ server: "", tools: [] });

    await getMcpTools("/ws", 1000);
    await getMcpTools("/ws", 1000 + MCP_CACHE_MS - 1);
    expect(listServers).toHaveBeenCalledTimes(1);
  });

  it("rediscovers once the entry is stale", async () => {
    invalidateMcpTools();
    listServers.mockClear();
    listServers.mockResolvedValue([]);

    await getMcpTools("/ws", 1000);
    await getMcpTools("/ws", 1000 + MCP_CACHE_MS + 1);
    expect(listServers).toHaveBeenCalledTimes(2);
  });

  it("keeps workspaces apart", async () => {
    invalidateMcpTools();
    listServers.mockClear();
    listServers.mockResolvedValue([]);

    await getMcpTools("/a", 1000);
    await getMcpTools("/b", 1000);
    expect(listServers).toHaveBeenCalledTimes(2);
  });
});
