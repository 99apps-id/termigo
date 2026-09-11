// Tool search: send the coding loop, load the rest on demand.
//
// Every enabled tool sends its full JSON Schema with every request. Measured on
// this repo: 125 tools / 80 KB / ~20k tokens before a word of the conversation,
// and half of it belongs to domains a given session cannot use.
//
// The AI SDK filters the serialised tool list by `activeTools`, which
// `prepareStep` can change per step (`prepare-tools-and-tool-choice.ts`:
// `tools.filter(([name]) => activeTools.includes(name))`). That is the
// mechanism this module drives: the run starts with the coding loop plus
// `find_tools`, and a tool becomes available for the rest of the run once the
// model has asked for it by name.
//
// Design notes, because the trade-offs are the point:
//
// - **Discovery is by keyword, not a directory.** Advertising every tool name
//   and a one-line description would still cost ~12 KB. `find_tools` costs
//   ~0.6 KB and names the *categories*, which is what a model needs to know
//   what to ask for.
// - **The always-on set is the coding loop, not the compact-tier core.** The
//   compact tier is a degraded mode for small models; search mode must keep
//   full capability, so interaction, file operations and verification are
//   always present. What is deferred is the ecosystem: browser, GitHub, LSP,
//   skills, SQL, PDF, images, worktrees, previews, PTY, workflows.
// - **A discovered tool stays active for the rest of the run.** Re-discovering
//   per step would tax every later step with a round trip it already paid for.

import { tool } from "ai";
import { z } from "zod";
import { CORE_TOOL_NAMES } from "../agents/agentFactory";

/** The discovery tool's name. Referenced by the fallback message too. */
export const FIND_TOOLS_NAME = "find_tools";

/**
 * Tools that stay in every request while search mode is on.
 *
 * `CORE_TOOL_NAMES` is the coding loop; the additions are the parts of it a
 * full-capability agent needs and the compact tier drops: asking the user,
 * reading images, running the verify loop, and the file operations that are
 * not plain writes.
 */
export const TOOL_SEARCH_ALWAYS_ON: ReadonlySet<string> = new Set([
  ...CORE_TOOL_NAMES,
  "ask_user",
  "read_image",
  "test_file",
  "format_code",
  "delete_file",
  "move_file",
  "copy_file",
  "replace_in_files",
  "revert_changes",
  "env_get",
  "remember",
]);

/** One searchable tool, reduced to what a keyword search needs. */
export type ToolIndexEntry = {
  name: string;
  /** First sentence of the tool's description, for the result list. */
  summary: string;
};

/** Where a tool lives, for grouping the results and writing the hint. */
function categoryOf(name: string): string {
  const i = name.indexOf("_");
  return i === -1 ? name : name.slice(0, i);
}

/** The first sentence, capped: a result list does not need the full manual. */
function firstSentence(description: string | undefined, cap = 140): string {
  const text = (description ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  const stop = text.search(/\.\s|\.$/);
  const sentence = stop === -1 ? text : text.slice(0, stop + 1);
  return sentence.length <= cap ? sentence : `${sentence.slice(0, cap - 1)}…`;
}

/**
 * The searchable index for a built toolset: everything except the tools that
 * are always active, since offering those would waste a discovery step on a
 * tool the model can already see.
 */
export function buildToolIndex(
  tools: Record<string, unknown>,
  alwaysOn: ReadonlySet<string> = TOOL_SEARCH_ALWAYS_ON,
): ToolIndexEntry[] {
  const out: ToolIndexEntry[] = [];
  for (const [name, value] of Object.entries(tools)) {
    if (alwaysOn.has(name) || name === FIND_TOOLS_NAME) continue;
    const description = (value as { description?: string } | undefined)
      ?.description;
    out.push({ name, summary: firstSentence(description) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The distinct categories present, for the hint and the tool description. */
export function indexCategories(
  index: readonly ToolIndexEntry[],
): string[] {
  return [...new Set(index.map((e) => categoryOf(e.name)))].sort();
}

type Scored = { entry: ToolIndexEntry; score: number };

/**
 * Rank the index against a free-text query.
 *
 * Pure and deterministic. The scoring is deliberately simple and legible -
 * exact name, then name substring, then word overlap on name and summary - so
 * that a miss is explainable ("the model asked for the wrong word") rather than
 * a tuning mystery. Matching is on lowercase words; a query with punctuation
 * still matches because non-word characters are separators.
 */
export function searchToolIndex(
  index: readonly ToolIndexEntry[],
  query: string,
  limit = 8,
): ToolIndexEntry[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const phrase = words.join("");
  const scored: Scored[] = [];

  for (const entry of index) {
    const name = entry.name.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const nameNoSep = name.replace(/_/g, "");
    let score = 0;

    if (name === query.trim().toLowerCase()) score += 100;
    if (nameNoSep === phrase) score += 60;
    if (name.includes(phrase)) score += 20;
    for (const word of words) {
      if (name === word) score += 30;
      else if (name.startsWith(`${word}_`)) score += 12;
      else if (name.includes(word)) score += 6;
      if (summary.includes(word)) score += 2;
    }
    if (score > 0) scored.push({ entry, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
  );
  return scored.slice(0, Math.max(1, limit)).map((s) => s.entry);
}

export type FindToolsResult = {
  matched: string[];
  tools: { name: string; summary: string }[];
  note: string;
};

/**
 * Run a search and report what became available.
 *
 * Exported separately from the tool so the "what did the model get" decision is
 * testable without the AI SDK.
 */
export function runFindTools(
  index: readonly ToolIndexEntry[],
  query: string,
  limit?: number,
): FindToolsResult {
  const matches = searchToolIndex(index, query, limit ?? 8);
  if (matches.length === 0) {
    const categories = indexCategories(index);
    return {
      matched: [],
      tools: [],
      note:
        `No tool matches "${query}". Available categories: ` +
        `${categories.join(", ")}. Try a single keyword, or the exact tool name.`,
    };
  }
  return {
    matched: matches.map((m) => m.name),
    tools: matches.map((m) => ({ name: m.name, summary: m.summary })),
    note:
      "These tools are now available. Call them directly - do not call " +
      `${FIND_TOOLS_NAME} again for the same thing.`,
  };
}

/**
 * The `find_tools` tool.
 *
 * `discover` is called with the matched names so the run can add them to the
 * next step's `activeTools`. The schema is `.strict()`-free on purpose: a model
 * that passes an extra key should still get a search, not a validation error.
 */
export function buildFindToolsTool(opts: {
  index: readonly ToolIndexEntry[];
  discover: (names: readonly string[]) => void;
  limit?: number;
}) {
  const categories = indexCategories(opts.index);
  return tool({
    description:
      `Search ${opts.index.length} additional tools that are not loaded in this ` +
      `request, and make the matches available. Call this before telling the ` +
      `user something is not possible. Categories: ${categories.join(", ")}. ` +
      `Search with a single keyword (e.g. "browser", "screenshot", "sql", ` +
      `"pdf", "workflow") or an exact tool name. List the matches it returns, ` +
      `then call the tool you need.`,
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Keyword or tool name to load. One or two words works better than a sentence.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum matches to load (default 8)."),
    }),
    execute: async ({ query, limit }) => {
      const result = runFindTools(opts.index, query, limit ?? opts.limit);
      if (result.matched.length > 0) opts.discover(result.matched);
      return result;
    },
  });
}

/**
 * The system-prompt hint for search mode.
 *
 * Without it the model does not know the deferred tools exist, so it reports a
 * missing capability instead of asking for it - the failure mode that makes
 * lazy loading feel broken. One sentence is enough; the tool's own description
 * carries the detail.
 */
export const TOOL_SEARCH_HINT =
  "Additional tools are loaded on demand and are NOT visible to you yet. " +
  `Before saying a capability is missing, call \`${FIND_TOOLS_NAME}\` with a ` +
  "keyword to load it. The core coding tools (files, shell, search, git, " +
  "sub-agents, todos) are already available.";
