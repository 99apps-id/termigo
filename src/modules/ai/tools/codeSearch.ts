import { tool } from "ai";
import { z } from "zod";
import {
  indexWorkspace,
  searchCode,
  getIndexStats,
  getIndexedRoot,
} from "../lib/codeIndex";
import { resolvePath, type ToolContext } from "./context";

/**
 * The index build in flight, with the root it belongs to.
 *
 * Tracking the root matters: this used to be a bare promise, so a build
 * started for repo A was handed back to a caller asking about repo B. That
 * caller then searched A while believing it had indexed B - the wrong tree,
 * silently. Tools are called one at a time today, but "you were answered from
 * another repo's index" is not a failure mode worth leaving reachable.
 */
let indexingPromise: {
  root: string;
  promise: Promise<{ files: number; chunks: number }>;
} | null = null;

async function ensureIndexed(
  root: string,
): Promise<{ files: number; chunks: number }> {
  const stats = getIndexStats();
  const currentIndexed = getIndexedRoot();
  if (stats.chunks > 0 && currentIndexed === root) {
    return stats;
  }
  if (indexingPromise && indexingPromise.root === root) {
    return indexingPromise.promise;
  }
  const promise = indexWorkspace(root).finally(() => {
    if (indexingPromise?.promise === promise) indexingPromise = null;
  });
  indexingPromise = { root, promise };
  return promise;
}

/**
 * Which directory a call operates on.
 *
 * `root` is optional and resolved like any other tool path, so an audit of a
 * repo that is NOT the workspace root (another checkout, a vendored copy, the
 * upstream being compared against) can be indexed and searched. Without it the
 * only reachable tree was the workspace, which is why a cross-repo comparison
 * ended up enumerating the other repo one directory at a time with `ls`.
 */
function targetRoot(ctx: ToolContext, explicit?: string): string | null {
  const asked = explicit?.trim();
  if (asked) return resolvePath(asked, ctx.getCwd());
  return ctx.getWorkspaceRoot() ?? ctx.getCwd();
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
          .preprocess((v) => {
            const num =
              typeof v === "string"
                ? parseInt(v, 10)
                : typeof v === "number"
                  ? v
                  : undefined;
            return typeof num === "number" && !Number.isNaN(num)
              ? Math.min(Math.max(1, Math.floor(num)), 100)
              : v;
          }, z.number().int().min(1).max(100).optional())
          .optional()
          .describe("Maximum results to return. Defaults to 10, capped at 100."),
        path_filter: z
          .string()
          .optional()
          .describe(
            "Optional subdirectory or path filter to narrow results (e.g. 'src/modules/ai').",
          ),
        root: z
          .string()
          .optional()
          .describe(
            "Directory to search instead of the workspace root. Pass this to search another checkout, e.g. 'C:/project/other-repo'.",
          ),
      }),
      execute: async ({ query, max_results, path_filter, root: askedRoot }) => {
        const root = targetRoot(ctx, askedRoot);
        if (!root) return { error: "no workspace root or cwd available" };

        const stats = await ensureIndexed(root);
        if (stats.chunks === 0) {
          return {
            error: `no indexable files found under ${root}. Check that the path is a directory that exists, then retry.`,
          };
        }

        const results = searchCode(query, max_results ?? 10, path_filter);
        return {
          query,
          // Reported so a cross-repo audit can see WHICH tree answered, instead
          // of assuming the workspace answered and silently reading the wrong
          // repo's hits as the other one's.
          searched: getIndexedRoot(),
          stats,
          results,
        };
      },
    }),

    code_index: tool({
      description:
        "Index a workspace for codebase search. Rebuilds the local BM25 index over code and configuration files. Use this once before asking `code_search` about an unfamiliar codebase, or when files have changed. Defaults to the workspace root; pass `root` to index another checkout (a large tree takes a while to build once, then searches are instant).",
      inputSchema: z.object({
        root: z
          .string()
          .optional()
          .describe(
            "Directory to index instead of the workspace root. Pass this to index another checkout, e.g. 'C:/project/other-repo'.",
          ),
      }),
      execute: async ({ root: askedRoot }) => {
        const root = targetRoot(ctx, askedRoot);
        if (!root) return { error: "no workspace root or cwd available" };
        if (indexingPromise && indexingPromise.root === root) {
          const stats = await indexingPromise.promise;
          return { status: "ok", root, ...stats };
        }
        const promise = indexWorkspace(root, true).finally(() => {
          if (indexingPromise?.promise === promise) indexingPromise = null;
        });
        indexingPromise = { root, promise };
        const stats = await promise;
        return { status: "ok", root, ...stats };
      },
    }),
  };
}
