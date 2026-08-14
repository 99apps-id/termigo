// Extension-contributed tools, reaching the agent.
//
// The whole path already existed: extensions declare tools in their manifest
// with a name, description, JSON Schema and an approval preference, the host
// accepts them through `contribute.aiTools`, and binds handlers through
// `registerAiToolHandler`. Everything was in place except the last step -
// nothing outside the extensions module ever read the registry, so an
// extension could register a tool perfectly and the agent would never see it.
//
// Same shape as MCP: build the tools before a run and pass them in, since
// `buildTools` is synchronous and these come from a live registry.

import { dynamicTool, jsonSchema, type Tool } from "ai";
import { aiToolsRegistry } from "@/modules/extensions/registries";
import { extToolName } from "./extensionToolNames";

// Re-exported so callers have one MCP-style entry point, while the light
// module stays importable on its own for anything on the startup path.
export {
  EXT_TOOL_PREFIX,
  extToolName,
  isExtensionTool,
  parseExtToolName,
} from "./extensionToolNames";

/**
 * An extension's declared schema, made safe to hand to the SDK.
 *
 * Extensions are third-party. A schema that is missing or is not an object
 * schema would surface as a provider error that reads like a Termigo bug, so
 * anything unusable degrades to an open object instead.
 */
export function extToolSchema(input: unknown): Record<string, unknown> {
  const ok =
    typeof input === "object" &&
    input !== null &&
    (input as { type?: unknown }).type === "object";
  return ok
    ? (input as Record<string, unknown>)
    : { type: "object", properties: {}, additionalProperties: true };
}

/** Description shown to the model, naming the extension it came from. */
export function describeExtTool(
  extensionId: string,
  description: string,
  needsApproval: boolean,
): string {
  const gate = needsApproval ? " Asks for approval." : "";
  return `${description.trim()}\n\n(From the "${extensionId}" extension.)${gate}`;
}

export type ExtensionToolset = Record<string, Tool>;

/**
 * Build callable tools from everything currently registered.
 *
 * Read fresh each run rather than cached: extensions are enabled, disabled and
 * reloaded while the app is open, and a cached toolset would offer the model
 * tools that no longer have a handler behind them.
 */
export function buildExtensionTools(): ExtensionToolset {
  const out: ExtensionToolset = {};
  for (const { extensionId, item } of aiToolsRegistry.list()) {
    if (!item?.name || !item?.description) continue;
    const needsApproval = item.approval !== "auto";
    const full = extToolName(extensionId, item.name);

    out[full] = dynamicTool({
      description: describeExtTool(extensionId, item.description, needsApproval),
      inputSchema: jsonSchema(extToolSchema(item.parameters)),
      // An extension declaring `auto` is asking for its tool to run unattended.
      // That is honoured, but only as far as the approval mode allows: the
      // policy still decides, and this is the tool's preference, not a bypass.
      needsApproval,
      execute: async (args) => {
        const handler = aiToolsRegistry.getRuntime(extensionId, item.name) as
          | ((a: Record<string, unknown>) => Promise<unknown> | unknown)
          | undefined;
        if (typeof handler !== "function") {
          // Declared but never bound: the extension listed the tool in its
          // manifest and did not call registerAiToolHandler, or was disabled
          // between the run starting and this call.
          return {
            error: `the "${extensionId}" extension declares ${item.name} but has no handler bound for it`,
          };
        }
        try {
          return await handler((args ?? {}) as Record<string, unknown>);
        } catch (e) {
          // Returned, not thrown: a broken extension should cost its own tool
          // call, not the whole run.
          return { error: String(e), extension: extensionId, tool: item.name };
        }
      },
    });
  }
  return out;
}
