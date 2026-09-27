import { tool } from "ai";
import { z } from "zod";
import { INDEXABLE_GLOB, MAX_INDEXED_FILES } from "../lib/codeIndex";
import { native } from "../lib/native";
import { diffTrees, filterByRel, type TreeFile } from "../lib/treeCompare";
import { resolvePath, type ToolContext } from "./context";

/** One glob per tree, fingerprinting every source and configuration file. */
async function manifest(
  root: string,
): Promise<{ files: TreeFile[]; truncated: boolean }> {
  const res = await native.glob({
    pattern: INDEXABLE_GLOB,
    root,
    maxResults: MAX_INDEXED_FILES,
  });
  const seen = new Set<string>();
  const files: TreeFile[] = [];
  for (const hit of res.hits) {
    if (seen.has(hit.rel)) continue;
    seen.add(hit.rel);
    files.push({
      rel: hit.rel,
      path: hit.path,
      mtime: hit.mtime ?? 0,
      size: hit.size ?? 0,
    });
  }
  return { files, truncated: res.truncated };
}

export function buildTreeCompareTools(ctx: ToolContext) {
  return {
    compare_trees: tool({
      description:
        "Compare two directory trees by manifest: which files exist on only one side, and which exist on both but differ in size or modification time. Use it to see how a fork, a vendored copy or another checkout diverges from a reference tree without enumerating either one directory at a time. It reports paths, not content: follow up on the paths that matter with read_file or a git diff. Covers source and configuration files (the same extensions code_search indexes).",
      inputSchema: z.object({
        left: z
          .string()
          .describe(
            "Reference tree, e.g. the upstream checkout. Absolute, or relative to the active terminal cwd.",
          ),
        right: z
          .string()
          .describe("Tree to compare against the reference, e.g. the fork."),
        path_filter: z
          .string()
          .optional()
          .describe(
            "Only compare paths containing this substring, e.g. 'src-tauri'.",
          ),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Entries listed per category. Defaults to 50."),
      }),
      execute: async ({ left, right, path_filter: rawFilter, max_results }) => {
        // Resolution and the glob below are the two calls that can fail on a
        // path the model guessed (a relative path with no terminal cwd, a
        // directory that does not exist). Both return `{ error }` rather than
        // throwing, so a bad argument is something the model can read and
        // correct instead of a tool failure that ends the run.
        let leftRoot: string;
        let rightRoot: string;
        try {
          leftRoot = resolvePath(left, ctx.getCwd());
          rightRoot = resolvePath(right, ctx.getCwd());
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        if (leftRoot === rightRoot) {
          return { error: "left and right resolve to the same directory" };
        }

        let l: { files: TreeFile[]; truncated: boolean };
        let r: { files: TreeFile[]; truncated: boolean };
        try {
          [l, r] = await Promise.all([
            manifest(leftRoot),
            manifest(rightRoot),
          ]);
        } catch (e) {
          return {
            error: `cannot read ${leftRoot} or ${rightRoot}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          };
        }
        if (l.files.length === 0 && r.files.length === 0) {
          return {
            error: `no source or configuration files found under ${leftRoot} or ${rightRoot}. Check that both paths exist and are directories.`,
          };
        }

        const filter = rawFilter?.trim();
        const leftFiles = filter ? filterByRel(l.files, filter) : l.files;
        const rightFiles = filter ? filterByRel(r.files, filter) : r.files;
        const diff = diffTrees(leftFiles, rightFiles);
        const cap = max_results ?? 50;

        return {
          left: leftRoot,
          right: rightRoot,
          path_filter: filter ?? null,
          // A glob that hit its cap means the comparison is partial; say so
          // rather than let a truncated list read as "nothing else differs".
          truncated: l.truncated || r.truncated,
          counts: {
            files_left: leftFiles.length,
            files_right: rightFiles.length,
            only_left: diff.onlyInLeft.length,
            only_right: diff.onlyInRight.length,
            changed: diff.changed.length,
            identical: diff.identical,
          },
          only_left: diff.onlyInLeft.slice(0, cap).map((f) => f.rel),
          only_right: diff.onlyInRight.slice(0, cap).map((f) => f.rel),
          changed: diff.changed.slice(0, cap).map((c) => ({
            path: c.left.rel,
            left_size: c.left.size,
            right_size: c.right.size,
          })),
        };
      },
    }),
  };
}
