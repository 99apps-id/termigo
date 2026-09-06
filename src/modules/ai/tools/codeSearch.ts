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
        "Codebase search across the workspace. Uses Okapi BM25 ranking over code and configuration chunks with code-aware tokenization, path boosting, and exact substring matching. Returns file paths, line ranges, relevance scores, and centered snippets. Use this when you need to find where something is implemented, discover symbols, or locate relevant code without knowing exact filenames.",
      inputSchema: z.object({
        query: z.string().describe("Natural language query or code symbol to search for."),
        max_results: z.number().int().min(1).max(20).optional().describe("Maximum results to return. Defaults to 10."),
        path_filter: z.string().optional().describe("Optional subdirectory or path filter to narrow results (e.g. 'src/modules/ai')."),
      }),
      execute: async ({ query, max_results, path_filter }) => {
        const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
        if (!root) return { error: "no workspace root or cwd available" };

        const stats = getIndexStats();
        if (stats.chunks === 0 && !indexing) {
          indexing = true;
          try {
            await indexWorkspace(root);
          } finally {
            indexing = false;
          }
        }

        const results = searchCode(query, max_results ?? 10, path_filter);
        return {
          query,
          stats: getIndexStats(),
          results,
        };
      },
    }),

    code_index: tool({
      description:
        "Index the workspace for codebase search. Rebuilds the local BM25 index over code and configuration files. Use this when files have changed or you want to ensure fresh results.",
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
