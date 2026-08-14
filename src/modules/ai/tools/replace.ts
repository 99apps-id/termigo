import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkWritableCanonical } from "../lib/security";
import {
  escapeRegex,
  isSelfReferential,
  MAX_REPLACE_FILES,
  replaceAllCount,
  uniquePaths,
} from "../lib/replaceText";
import { remoteUnsupported } from "../lib/remoteFs";
import { resolvePath, type ToolContext } from "./context";

export function buildReplaceTools(ctx: ToolContext) {
  return {
    replace_in_files: tool({
      description:
        "Replace a literal string across every matching file under a directory. The search is literal text, not a regex. Use it for renames and sweeping updates that would otherwise be many `edit` calls. Returns the per-file replacement counts so you can check the result. Refuses if more than " +
        `${MAX_REPLACE_FILES} files would change — narrow with \`glob\` or a deeper \`path\` instead. Asks for approval.`,
      inputSchema: z.object({
        search: z.string().min(1).describe("Literal text to find. Not a regex."),
        replace: z.string().describe("Literal replacement. May be empty to delete the text."),
        path: z
          .string()
          .optional()
          .describe("Directory to search under. Defaults to the terminal cwd."),
        glob: z
          .array(z.string())
          .optional()
          .describe('File globs to limit the sweep, e.g. ["**/*.ts"].'),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report what would change without writing anything."),
      }),
      needsApproval: true,
      execute: async ({ search, replace, path, glob, dry_run }) => {
        // This is grep plus a write, and grep has no remote backend. Sweeping
        // the local tree while the user is working on a server would rewrite
        // the wrong machine's files wholesale.
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "replace_in_files",
            "Use suggest_command to run `grep -rl OLD DIR | xargs sed -i 's/OLD/NEW/g'` at the remote prompt.",
          );
        }
        const root = resolvePath(path ?? ".", ctx.getCwd());

        let hits: Awaited<ReturnType<typeof native.grep>>;
        try {
          hits = await native.grep({
            // Escaped, because `search` is a literal and the backend takes a
            // regex. Without this, a dot or bracket in the text would silently
            // match more than the user asked for.
            pattern: escapeRegex(search),
            root,
            glob,
          });
        } catch (e) {
          return { error: String(e), path: root };
        }

        const files = uniquePaths(hits.hits);
        if (files.length === 0) {
          return { changed: 0, replacements: 0, files: [], searched: root };
        }
        if (files.length > MAX_REPLACE_FILES) {
          // Refusing beats truncating: a partial sweep leaves the codebase in a
          // state neither the model nor the user can reason about.
          return {
            error: `${files.length} files match, over the ${MAX_REPLACE_FILES} file limit; narrow with glob or a deeper path`,
            files: files.slice(0, 10),
            searched: root,
          };
        }

        const changed: { path: string; replacements: number }[] = [];
        const failed: { path: string; error: string }[] = [];
        let total = 0;

        for (const file of files) {
          const safety = await checkWritableCanonical(file, native.canonicalize);
          if (!safety.ok) {
            failed.push({ path: file, error: safety.reason });
            continue;
          }
          try {
            const read = await native.readFile(safety.canonical);
            // Binary files can match a byte sequence without the text meaning
            // anything; rewriting one would corrupt it.
            if (read.kind !== "text") {
              failed.push({ path: file, error: "not a text file" });
              continue;
            }
            const out = replaceAllCount(read.content, search, replace);
            if (out.count === 0) continue;
            if (!dry_run) await native.writeFile(safety.canonical, out.content);
            changed.push({ path: safety.canonical, replacements: out.count });
            total += out.count;
          } catch (e) {
            failed.push({ path: file, error: String(e) });
          }
        }

        return {
          ...(dry_run ? { dry_run: true } : {}),
          changed: changed.length,
          replacements: total,
          files: changed,
          ...(failed.length > 0 ? { skipped: failed } : {}),
          ...(hits.truncated
            ? { warning: "the search hit its result cap; some files may be missed" }
            : {}),
          ...(isSelfReferential(search, replace)
            ? {
                warning_self_referential:
                  "the replacement contains the search text, so running this again would keep growing the files",
              }
            : {}),
          searched: root,
        };
      },
    }),
  };
}
