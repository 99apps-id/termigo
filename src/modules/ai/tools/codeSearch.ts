import { tool } from "ai";
import { z } from "zod";
import {
  indexWorkspace,
  searchCode,
  getIndexStats,
} from "../lib/codeIndex";
import type { ToolContext } from "./context";

let indexing = false;

export function buildCodeSearchTools(ctx: ToolContext) {
  return {
    code_search: tool({
      description:
        "Semantic code search across the workspace. Uses a local TF-IDF index over code chunks to find relevant code by natural language query. Returns file paths, line ranges, relevance scores, and snippets. Use this when you need to find where something is implemented, or discover relevant code without knowing exact symbols.",
      inputSchema: z.object({
        query: z.string().describe("Natural language query describing the code you are looking for."),
        max_results: z.number().int().min(1).max(20).optional().describe("Maximum results to return. Defaults to 10."),
      }),
      execute: async ({ query, max_results }) => {
        const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
        if (!root) return { error: "no workspace root or cwd available" };

        const stats = getIndexStats();
        if (stats.chunks === 0) {
          await indexWorkspace(root);
        }

        const results = searchCode(query, max_results ?? 10);
        return {
          query,
          stats: getIndexStats(),
          results,
        };
      },
    }),

    code_index: tool({
      description:
        "Index the workspace for semantic code search. Rebuilds the local TF-IDF index over code files. Use this when the index is stale or you want to ensure fresh results.",
      inputSchema: z.object({}),
      execute: async () => {
        if (indexing) return { status: "indexing" };
        const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
        if (!root) return { error: "no workspace root or cwd available" };
        indexing = true;
        try {
          const stats = await indexWorkspace(root);
          return { status: "ok", ...stats };
        } finally {
          indexing = false;
        }
      },
    }),
  };
}
