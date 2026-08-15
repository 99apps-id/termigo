// Typed wrappers over the Rust `mcp` commands.
//
// The registry is the same `.termigo/mcp.json` the Go companion CLI reads, so a
// server configured for one is available to the other. Project entries override
// user entries of the same name.

import { invoke } from "@tauri-apps/api/core";

export type McpScope = "project" | "user";

export type McpServer = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  scope: McpScope;
  cwd: string | null;
};

export type McpTool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments, passed through from the server. */
  inputSchema: unknown;
};

export type McpToolList = {
  server: string;
  tools: McpTool[];
};

/** Configured servers for a workspace, merged with the user-level registry. */
export async function mcpListServers(
  workspace?: string | null,
): Promise<McpServer[]> {
  return invoke<McpServer[]>("mcp_list_servers", {
    workspace: workspace ?? null,
  });
}

/** Connect to one server and list the tools it exposes. */
export async function mcpListTools(
  server: string,
  workspace?: string | null,
): Promise<McpToolList> {
  return invoke<McpToolList>("mcp_list_tools", {
    server,
    workspace: workspace ?? null,
  });
}

/** Invoke a tool. The result is the server's raw `tools/call` payload. */
export async function mcpCallTool(
  server: string,
  tool: string,
  args?: Record<string, unknown>,
  workspace?: string | null,
): Promise<unknown> {
  return invoke<unknown>("mcp_call_tool", {
    server,
    tool,
    arguments: args ?? {},
    workspace: workspace ?? null,
  });
}

/** Round-trip a `ping`, to check a server starts and answers. */
export async function mcpPing(
  server: string,
  workspace?: string | null,
): Promise<boolean> {
  return invoke<boolean>("mcp_ping", { server, workspace: workspace ?? null });
}

/** Add or replace a user-level server in `~/.termigo/mcp.json`. */
export async function mcpAddServer(input: {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<void> {
  return invoke("mcp_add_server", input);
}

/** Remove a user-level server. Project-scope entries are untouched. */
export async function mcpRemoveServer(name: string): Promise<void> {
  return invoke("mcp_remove_server", { name });
}
