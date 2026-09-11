// What the agent is told when it calls a tool that does not exist.
//
// A model asked for a tool Termigo does not have. That is a normal event - a
// model trained elsewhere reaches for `view_file` or `run_command` - and the
// answer decides whether the run recovers in one step or stalls:
//
// - If the reply names the real tools that exist, the model corrects itself.
// - If the reply hands back a wrong or truncated list, the model concludes the
//   capability is missing and either gives up or invents a workaround.
//
// The reply used to be a hardcoded list of 13 tool names, written when the
// toolset was smaller. By the time it was found the toolset had 125 tools, so a
// model asking for a real tool that merely was not in those 13 - `git_status`,
// `run_checks`, every browser and GitHub tool - was told it did not exist. The
// list is now derived from the toolset actually in the request, and the message
// is built by a pure function so the wording can be asserted in a test.

import { tool } from "ai";
import { z } from "zod";
import { suggestToolNames } from "../lib/toolNames";

export const UNKNOWN_TOOL_NAME = "unknown_tool_fallback";

/** Everything the reply needs. Kept as data so the wording stays testable. */
export type UnknownToolInput = {
  /** The name the model asked for. */
  requested: string;
  /** Tool names actually present in this request, in registration order. */
  available: readonly string[];
  /**
   * The cross-ecosystem name this maps to, when the alias table knows it. The
   * repair hook rewrites these before they reach here, so this is only set when
   * the canonical tool is genuinely absent (e.g. search mode has not loaded it),
   * and saying so is more useful than "unknown name".
   */
  aliasFor?: string | null;
  /** The discovery tool's name, when tools are loaded on demand. */
  findToolsName?: string;
  /** How many suggestions to name. A long list is noise. */
  suggestLimit?: number;
};

/**
 * The reply text.
 *
 * Order matters: the correction first (what to call instead), then how to find
 * anything else, then the full list as the last resort. A model that reads only
 * the first line still has the actionable part.
 */
export function buildUnknownToolMessage(input: UnknownToolInput): string {
  const { requested, available } = input;
  const limit = input.suggestLimit ?? 5;
  const lines: string[] = [
    `Tool "${requested}" does not exist in this environment.`,
  ];

  if (input.aliasFor) {
    lines.push(
      `That name is a synonym: the equivalent tool here is "${input.aliasFor}". Call it instead.`,
    );
  }

  const suggestions = suggestToolNames(requested, available, limit);
  if (suggestions.length > 0) {
    lines.push(`Did you mean: ${suggestions.join(", ")}?`);
  }

  if (input.findToolsName) {
    lines.push(
      `More tools are available on demand: call "${input.findToolsName}" with a keyword (e.g. "browser", "git", "sql") to load them.`,
    );
  }

  lines.push(
    `Do not retry "${requested}". Tools available in this request: ${[...available].sort().join(", ")}.`,
  );
  return lines.join("\n");
}

/**
 * The fallback tool.
 *
 * Its description tells the model this is not a capability but an error path,
 * so it is not chosen deliberately; `available` is read at call time so a tool
 * added or gated later is reflected without touching this file.
 */
export function buildUnknownToolFallback(opts: {
  available: () => readonly string[];
  aliasFor?: (name: string) => string | null;
  findToolsName?: string;
  suggestLimit?: number;
}) {
  return tool({
    description:
      "Error path only, not a capability. Called automatically when a requested tool does not exist; never choose it yourself.",
    inputSchema: z.object({
      requested_tool: z.string().describe("The tool name that did not exist."),
      provided_input: z
        .string()
        .optional()
        .describe("Received arguments, echoed back for diagnosis."),
    }),
    execute: async ({ requested_tool, provided_input }) => {
      const available = opts.available();
      let aliasFor: string | null = null;
      try {
        aliasFor = opts.aliasFor?.(requested_tool) ?? null;
      } catch {
        aliasFor = null;
      }
      // An alias whose canonical tool is present would have been rewritten
      // already; only mention it when the target really is missing.
      if (aliasFor && !available.includes(aliasFor)) aliasFor = null;
      return {
        error: buildUnknownToolMessage({
          requested: requested_tool,
          available,
          aliasFor,
          findToolsName: opts.findToolsName,
          suggestLimit: opts.suggestLimit,
        }),
        toolDoesNotExist: true,
        ...(provided_input !== undefined
          ? { receivedInput: provided_input.slice(0, 500) }
          : {}),
      };
    },
  });
}
