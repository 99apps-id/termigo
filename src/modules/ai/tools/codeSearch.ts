import { tool } from "ai";
import { z } from "zod";
import {
  indexWorkspace,
  searchCode,
  getIndexStats,
  getIndexedRoot,
} from "../lib/codeIndex";
import type { ToolContext } from "./context";

let indexingPromise: Promise<{ files: number; chunks: number }> | null = null;

async function ensureIndexed(
  root: string,
): Promise<{ files: number; chunks: number }> {
  const stats = getIndexStats();
  const currentIndexed = getIndexedRoot();
  if (stats.chunks > 0 && currentIndexed === root) {
    return stats;
  }
  if (!indexingPromise) {
    indexingPromise = indexWorkspace(root).finally(() => {
      indexingPromise = null;
    });
  }
  return indexingPromise;
}

export function buildCodeSearchTools(ctx: ToolContext) {
  return {
    code_search: tool({
      description:
        "Codebase search across the workspace. Uses Okapi BM25 ranking over syntax-aware code and configuration chunks with scope-boundary detection, path boosting, and exact substring matching. Returns file paths, line ranges, relevance scores, centered snippets, and enclosing scope headers (functions, classes, structs). Use this when you need to find where something is implemented, discover symbols, or locate relevant code without knowing exact filenames.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Natural language query or code symbol to search for."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum results to return. Defaults to 10."),
        path_filter: z
          .string()
          .optional()
          .describe(
            "Optional subdirectory or path filter to narrow results (e.g. 'src/modules/ai').",
          ),
      }),
      execute: async ({ query, max_results, path_filter }) => {
        const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
        if (!root) return { error: "no workspace root or cwd available" };

        await ensureIndexed(root);

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
        const root = ctx.getWorkspaceRoot() ?? ctx.getCwd();
        if (!root) return { error: "no workspace root or cwd available" };
        if (indexingPromise) {
          const stats = await indexingPromise;
          return { status: "ok", ...stats };
        }
        indexingPromise = indexWorkspace(root).finally(() => {
          indexingPromise = null;
        });
        const stats = await indexingPromise;
        return { status: "ok", ...stats };
      },
    }),
  };
}
