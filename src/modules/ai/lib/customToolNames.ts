// Naming for user-defined command tools.
//
// Dependency-free for the same reason as mcpToolNames and extensionToolNames:
// the approval policy recognises one by name and is reached from the startup
// path, so it must not pull the AI SDK in with it.

/** Prefix marking a tool as user-defined, the way `mcp__` marks MCP. */
export const CUSTOM_TOOL_PREFIX = "cmd__";

export function customToolName(name: string): string {
  return `${CUSTOM_TOOL_PREFIX}${name}`;
}

export function isCustomTool(name: string): boolean {
  return name.startsWith(CUSTOM_TOOL_PREFIX);
}
