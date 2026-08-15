// Naming for MCP-backed tools.
//
// Deliberately dependency-free. The approval policy needs to recognise an MCP
// tool by name, and it is reached from the startup path; importing the module
// that builds the tools would drag the whole AI SDK into the initial bundle.
// The names are just string handling, so they live apart from the machinery.

/**
 * Prefix that marks a tool as coming from an MCP server.
 *
 * `mcp__<server>__<tool>` follows the convention MCP hosts have settled on, so
 * a user who has seen MCP elsewhere reads these names without explanation. It
 * also makes the origin recoverable from the name alone.
 */
export const MCP_TOOL_PREFIX = "mcp__";

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

/** True for a tool name produced by `mcpToolName`. */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Split a prefixed name back into its parts.
 *
 * Server names can contain underscores, so the split is anchored on the LAST
 * `__` rather than the first: `mcp__my_server__read_file` is the `read_file`
 * tool of `my_server`, not the `server__read_file` tool of `my`.
 */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string } | null {
  if (!isMcpTool(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.lastIndexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}
