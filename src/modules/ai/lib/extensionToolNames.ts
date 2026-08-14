// Naming for extension-contributed tools.
//
// Dependency-free for the same reason as mcpToolNames: the approval policy
// needs to recognise one by name and is reached from the startup path, so
// importing the builder would pull the AI SDK and the extension registry into
// the initial bundle. The eager-budget test catches that; this avoids it.

/** Marks a tool as coming from an extension, the way `mcp__` marks MCP. */
export const EXT_TOOL_PREFIX = "ext__";

export function extToolName(extensionId: string, tool: string): string {
  return `${EXT_TOOL_PREFIX}${extensionId}__${tool}`;
}

export function isExtensionTool(name: string): boolean {
  return name.startsWith(EXT_TOOL_PREFIX);
}

/**
 * Split a prefixed name back into its parts.
 *
 * Anchored on the LAST `__`, since extension ids contain underscores:
 * `ext__my_ext__do_thing` is `do_thing` from `my_ext`.
 */
export function parseExtToolName(
  name: string,
): { extensionId: string; tool: string } | null {
  if (!isExtensionTool(name)) return null;
  const rest = name.slice(EXT_TOOL_PREFIX.length);
  const at = rest.lastIndexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { extensionId: rest.slice(0, at), tool: rest.slice(at + 2) };
}
