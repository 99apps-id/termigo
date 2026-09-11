// What the toolset actually costs in the request.
//
// The run-summary line reports the prompt as components so that a feature which
// adds kilobytes shows up the day it lands. Its tool component counted
// `tool.inputSchema.jsonSchema` - which only exists for `jsonSchema()`-built
// tools (MCP servers) - and fell back to the description for everything else.
// Built-in tools describe themselves with Zod, so the schemas that are the bulk
// of the payload were invisible: the log said 37 KB while the real tool block
// was 79 KB, an undercount of more than half in the one report meant to catch
// growth.
//
// Here the Zod schema is converted to the JSON Schema that will be serialised
// to the provider, so the number is the real one. Conversion is cached per tool
// NAME: a tool's schema is defined in code and does not vary between runs, so
// the cost is paid once per process instead of once per run.

import { z } from "zod";

/** Bytes of the JSON Schema for one tool, or null when it cannot be read. */
function schemaBytes(tool: unknown): number | null {
  const t = tool as { inputSchema?: unknown } | undefined;
  const schema = t?.inputSchema;
  if (!schema) return null;
  // An MCP tool already carries the JSON Schema it was declared with.
  const raw = (schema as { jsonSchema?: unknown }).jsonSchema;
  if (raw !== undefined) {
    try {
      return JSON.stringify(raw).length;
    } catch {
      return null;
    }
  }
  try {
    // Zod 4. Throws for a schema it cannot express (a transform, a lazy cycle),
    // which is why the caller keeps a fallback rather than trusting this.
    return JSON.stringify(z.toJSONSchema(schema as never)).length;
  } catch {
    return null;
  }
}

type CacheEntry = { description: number; schema: number | null };
const cache = new Map<string, CacheEntry>();
/** Bound the cache so a stream of dynamic tool names cannot grow it forever. */
const CACHE_MAX = 512;

/**
 * The bytes one tool contributes to the request: its name, description and
 * serialised input schema.
 *
 * `exact` is false when the schema could not be converted, in which case only
 * the description is counted and the total is a lower bound.
 */
export function toolPayloadBytes(
  name: string,
  tool: unknown,
): { bytes: number; exact: boolean } {
  const description =
    (tool as { description?: string } | undefined)?.description ?? "";
  const hit = cache.get(name);
  let entry: CacheEntry;
  if (hit && hit.description === description.length) {
    entry = hit;
  } else {
    entry = { description: description.length, schema: schemaBytes(tool) };
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(name, entry);
  }
  const schema = entry.schema ?? 0;
  // Mirrors how the provider receives it: an object per tool with its name,
  // description and schema.
  const bytes =
    JSON.stringify({ name, description, schema: null }).length + schema;
  return { bytes, exact: entry.schema !== null };
}

export type ToolPayload = {
  /** Total bytes of the tool block as sent. */
  bytes: number;
  count: number;
  /** Tools whose schema could not be measured (the total is then a floor). */
  unmeasured: number;
  /** Bytes per tool, largest first. */
  byTool: { name: string; bytes: number }[];
};

/** Measure a built toolset. Pure apart from the name-keyed schema cache. */
export function measureToolPayload(
  tools: Record<string, unknown>,
): ToolPayload {
  let bytes = 0;
  let unmeasured = 0;
  const byTool: { name: string; bytes: number }[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const r = toolPayloadBytes(name, tool);
    bytes += r.bytes;
    if (!r.exact) unmeasured += 1;
    byTool.push({ name, bytes: r.bytes });
  }
  byTool.sort((a, b) => b.bytes - a.bytes);
  return { bytes, count: byTool.length, unmeasured, byTool };
}

/** Rough token count for a byte size. Four bytes per token is the usual
 *  English/code ratio and is what the other prompt components use. */
export function bytesToTokens(bytes: number): number {
  return Math.round(bytes / 4);
}
