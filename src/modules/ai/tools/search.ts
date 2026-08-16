import { sshExec } from "@/modules/ssh/bridge";
import {
  buildFindCommand,
  buildGrepCommand,
  isNoMatches,
  parseFindOutput,
  parseGrepOutput,
  REMOTE_SEARCH_MAX_RESULTS,
  resolveRemoteRoot,
} from "../lib/remoteSearch";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkReadable, checkReadableCanonical } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

function resolveRoot(
  rawRoot: string | undefined,
  ctx: ToolContext,
): { ok: true; path: string } | { ok: false; error: string } {
  if (rawRoot && rawRoot.trim().length > 0) {
    try {
      return { ok: true, path: resolvePath(rawRoot, ctx.getCwd()) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const ws = ctx.getWorkspaceRoot();
  if (ws) return { ok: true, path: ws };
  const cwd = ctx.getCwd();
  if (cwd) return { ok: true, path: cwd };
  return {
    ok: false,
    error: "no workspace root or active cwd; pass `root` explicitly.",
  };
}

const MAX_LINE_LEN = 160;

function clipLine(s: string): string {
  if (s.length <= MAX_LINE_LEN) return s;
  return `${s.slice(0, MAX_LINE_LEN)}…[+${s.length - MAX_LINE_LEN}]`;
}

function pathForSafety(path: string, root: string): string {
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return path;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.endsWith(sep) ? `${root}${path}` : `${root}${sep}${path}`;
}

function isReadableSearchHit(path: string, root: string): boolean {
  return checkReadable(pathForSafety(path, root)).ok;
}

export function buildSearchTools(ctx: ToolContext) {
  return {
    grep: tool({
      description:
        "Search file contents in the workspace using a regular expression. Honors .gitignore. Returns up to `max_results` (default 30, max 500) `{path, line, text}` hits, with a `truncated` flag when more existed. Long match lines are clipped to 160 chars. Use this for code navigation — do NOT brute-force read_file across the tree. Narrow with `glob` when you can; raise `max_results` only if the first batch truly isn't enough.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            "Regex pattern (Rust ripgrep dialect). Anchor and escape literal characters as needed.",
          ),
        root: z
          .string()
          .optional()
          .describe(
            "Root to search under. Defaults to workspace root, then active cwd.",
          ),
        // A bare string is accepted as well as a list. Models reach for
        // `"glob": "src/**/*.ts"` when they have exactly one pattern, and the
        // array-only schema rejected the whole call - the tool never ran, and
        // the run died on a validation error rather than a search.
        // `.transform` before `.optional()`: the other order makes the key
        // required-with-undefined rather than optional, which every existing
        // caller that omits a glob would then fail to type-check against.
        glob: z
          .union([z.string(), z.array(z.string())])
          .transform((g) => (typeof g === "string" ? [g] : g))
          .optional()
          .describe(
            "Optional include-globs over relative paths. One pattern or several: 'src/**/*.ts' or ['**/*.ts', 'src/**/*.tsx'].",
          ),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().int().min(1).max(500).optional(),
      }),
      execute: async ({
        pattern,
        root,
        glob,
        case_insensitive,
        max_results,
      }) => {
        const remote = ctx.getRemoteSession();
        if (remote) {
          // The server's own grep, not an SFTP walk: a recursive walk is one
          // round trip per directory plus a download per candidate, for a
          // search the remote box does locally in milliseconds.
          const resolved = resolveRemoteRoot(root, remote.cwd);
          if (!resolved.ok) return { error: resolved.error, remote: true };
          const target = resolved.path;
          try {
            const out = await sshExec(
              remote.sessionId,
              buildGrepCommand({
                pattern,
                path: target,
                glob,
                caseInsensitive: case_insensitive,
                maxResults: max_results,
              }),
            );
            if (isNoMatches(out.exitCode, out.stdout)) {
              return { remote: true, root: target, hits: [], count: 0 };
            }
            if (out.exitCode !== null && out.exitCode > 1 && !out.stdout) {
              return { error: out.stderr.trim() || `grep exited ${out.exitCode}`, remote: true };
            }
            const hits = parseGrepOutput(out.stdout);
            return {
              remote: true,
              root: target,
              count: hits.length,
              hits,
              ...(out.truncated || hits.length >= REMOTE_SEARCH_MAX_RESULTS
                ? { truncated: true }
                : {}),
            };
          } catch (e) {
            return { error: String(e), remote: true };
          }
        }
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(
          r.path,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        const cap = Math.min(max_results ?? 30, 500);
        try {
          const res = await native.grep({
            pattern,
            root: r.path,
            glob,
            caseInsensitive: case_insensitive,
            maxResults: cap,
          });
          const hits = res.hits.filter((h) =>
            isReadableSearchHit(h.path, r.path),
          );
          return {
            root: r.path,
            hits: hits.map((h) => ({
              path: h.path,
              rel: h.rel,
              line: h.line,
              text: clipLine(h.text),
            })),
            truncated: res.truncated,
            files_scanned: res.files_scanned,
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),

    glob: tool({
      description:
        "Find files by path pattern (gitignore-aware). Use over `list_directory` when you want all matches recursively. Patterns use globset syntax: `**/*.ts`, `src/**/test_*.py`. Returns up to `max_results` matches.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern over relative paths."),
        root: z.string().optional(),
        max_results: z.number().int().min(1).max(2000).optional(),
      }),
      execute: async ({ pattern, root, max_results }) => {
        const remote = ctx.getRemoteSession();
        if (remote) {
          const resolved = resolveRemoteRoot(root, remote.cwd);
          if (!resolved.ok) return { error: resolved.error, remote: true };
          const target = resolved.path;
          try {
            const out = await sshExec(
              remote.sessionId,
              buildFindCommand({ pattern, path: target, maxResults: max_results }),
            );
            const paths = parseFindOutput(out.stdout);
            return {
              remote: true,
              root: target,
              count: paths.length,
              hits: paths.map((p) => ({ path: p })),
              ...(out.truncated || paths.length >= REMOTE_SEARCH_MAX_RESULTS
                ? { truncated: true }
                : {}),
            };
          } catch (e) {
            return { error: String(e), remote: true };
          }
        }
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(
          r.path,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        try {
          const res = await native.glob({
            pattern,
            root: r.path,
            maxResults: max_results,
          });
          return {
            root: r.path,
            hits: res.hits.filter((h) => isReadableSearchHit(h.path, r.path)),
            truncated: res.truncated,
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),
  } as const;
}
