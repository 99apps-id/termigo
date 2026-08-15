// Exposing MCP servers' tools to the agent.
//
// The Rust side and the typed bridge for MCP already existed, but nothing
// imported the bridge: the commands were registered, servers could be
// configured in `.termigo/mcp.json`, and the agent still received not a single
// MCP tool. This is the missing connection.
//
// Discovery is async (each server is a child process that has to start and
// answer `tools/list`) while `buildTools` is synchronous, so the list is
// fetched before the run and passed in, the same way project memory is.

import { dynamicTool, jsonSchema, type Tool } from "ai";
import { mcpToolName } from "./mcpToolNames";
import {
  mcpCallTool,
  mcpListServers,
  mcpListTools,
  type McpTool,
} from "@/modules/mcp/bridge";

/** Servers this many milliseconds stale are re-queried. */
export const MCP_CACHE_MS = 60_000;

/**
 * Describe an MCP tool for the model.
 *
 * The server name is carried in the text because the model sees many tools
 * from many servers at once and the prefix alone reads as noise.
 */
export function describeMcpTool(server: string, tool: McpTool): string {
  const own = tool.description?.trim();
  const base = own || `The \`${tool.name}\` tool.`;
  return `${base}\n\n(From the "${server}" MCP server. Asks for approval.)`;
}

/**
 * An MCP server's own schema, made safe to hand to the SDK.
 *
 * Servers are third-party and some send no schema at all, or something that is
 * not an object schema. Passing that through produces a provider-side error
 * that looks like a bug in Termigo, so anything unusable degrades to an open
 * object rather than breaking the whole run.
 */
export function toolSchema(input: unknown): Record<string, unknown> {
  const ok =
    typeof input === "object" &&
    input !== null &&
    (input as { type?: unknown }).type === "object";
  return ok
    ? (input as Record<string, unknown>)
    : { type: "object", properties: {}, additionalProperties: true };
}

// Re-exported so callers have one MCP entry point; the light module stays
// importable on its own for anything on the startup path.
export { isMcpTool, mcpToolName, parseMcpToolName, MCP_TOOL_PREFIX } from "./mcpToolNames";

export type McpToolset = Record<string, Tool>;

/**
 * Build callable tools for every configured server.
 *
 * One unreachable server must not cost the agent every other server's tools -
 * MCP servers are child processes and any of them can fail to start - so each
 * is discovered independently and a failure drops only that server.
 */
export async function loadMcpTools(
  workspaceRoot: string | null,
): Promise<McpToolset> {
  let servers: Awaited<ReturnType<typeof mcpListServers>>;
  try {
    servers = await mcpListServers(workspaceRoot);
  } catch {
    return {}; // no registry, or the command is unavailable
  }

  const perServer = await Promise.all(
    servers.map(async (s) => {
      try {
        const listed = await mcpListTools(s.name, workspaceRoot);
        return { server: s.name, tools: listed.tools };
      } catch (e) {
        console.warn(`[mcp] server "${s.name}" did not list tools:`, e);
        return { server: s.name, tools: [] as McpTool[] };
      }
    }),
  );

  const out: McpToolset = {};
  for (const { server, tools } of perServer) {
    for (const t of tools) {
      out[mcpToolName(server, t.name)] = dynamicTool({
        description: describeMcpTool(server, t),
        inputSchema: jsonSchema(toolSchema(t.inputSchema)),
        // Every MCP tool is third-party code doing something the app cannot
        // inspect, so it asks unless the user has delegated everything.
        needsApproval: true,
        execute: async (args) => {
          try {
            return await mcpCallTool(
              server,
              t.name,
              (args ?? {}) as Record<string, unknown>,
              workspaceRoot,
            );
          } catch (e) {
            // Returned, not thrown: the model should see the failure and pick
            // another route rather than have the run collapse.
            return { error: String(e), server, tool: t.name };
          }
        },
      });
    }
  }
  return out;
}

type CacheEntry = { at: number; tools: McpToolset };
const cache = new Map<string, CacheEntry>();

/**
 * Cached discovery.
 *
 * Without this every message would spawn every configured server again, which
 * is both slow and a lot of process churn for a list that rarely changes.
 */
export async function getMcpTools(
  workspaceRoot: string | null,
  now = Date.now(),
): Promise<McpToolset> {
  const key = workspaceRoot ?? "";
  const hit = cache.get(key);
  if (hit && now - hit.at < MCP_CACHE_MS) return hit.tools;
  const tools = await loadMcpTools(workspaceRoot);
  cache.set(key, { at: now, tools });
  return tools;
}

/** Drop the cache so the next run rediscovers. For config changes. */
export function invalidateMcpTools(): void {
  cache.clear();
}
