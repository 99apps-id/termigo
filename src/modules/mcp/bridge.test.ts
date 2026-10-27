import { describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  mcpAddServer,
  mcpCallTool,
  mcpListServers,
  mcpListTools,
  mcpPing,
  mcpRemoveServer,
  mcpSetToolEnabled,
} from "./bridge";

describe("mcp bridge", () => {
  it("lists servers with a null workspace when none is given", async () => {
    invoke.mockResolvedValueOnce([]);
    await mcpListServers();
    expect(invoke).toHaveBeenCalledWith("mcp_list_servers", {
      workspace: null,
    });
  });

  it("passes the workspace through to tools and ping", async () => {
    invoke.mockResolvedValueOnce({ server: "s", tools: [] });
    await mcpListTools("s", "/ws");
    expect(invoke).toHaveBeenCalledWith("mcp_list_tools", {
      server: "s",
      workspace: "/ws",
    });

    invoke.mockResolvedValueOnce(true);
    await mcpPing("s", "/ws");
    expect(invoke).toHaveBeenCalledWith("mcp_ping", {
      server: "s",
      workspace: "/ws",
    });
  });

  it("sends tool enable/disable with server, tool and flag", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await mcpSetToolEnabled("github", "dangerous_tool", false);
    expect(invoke).toHaveBeenCalledWith("mcp_set_tool_enabled", {
      server: "github",
      tool: "dangerous_tool",
      enabled: false,
    });

    invoke.mockResolvedValueOnce(undefined);
    await mcpSetToolEnabled("github", "dangerous_tool", true);
    expect(invoke).toHaveBeenCalledWith("mcp_set_tool_enabled", {
      server: "github",
      tool: "dangerous_tool",
      enabled: true,
    });
  });

  it("calls a tool with default empty args", async () => {
    invoke.mockResolvedValueOnce({ ok: true });
    await mcpCallTool("s", "t");
    expect(invoke).toHaveBeenCalledWith("mcp_call_tool", {
      server: "s",
      tool: "t",
      arguments: {},
      workspace: null,
    });
  });

  it("adds and removes user-level servers", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await mcpAddServer({ name: "n", command: "c", args: [], env: {} });
    expect(invoke).toHaveBeenCalledWith("mcp_add_server", {
      name: "n",
      command: "c",
      args: [],
      env: {},
    });

    invoke.mockResolvedValueOnce(undefined);
    await mcpRemoveServer("n");
    expect(invoke).toHaveBeenCalledWith("mcp_remove_server", { name: "n" });
  });
});
