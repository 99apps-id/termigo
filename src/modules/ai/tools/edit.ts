import { sftpReadFile, sftpWriteFile } from "@/modules/ssh/sftp";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { fileCacheKey, routePath } from "../lib/remoteFs";
import { checkWritable, checkWritableCanonical } from "../lib/security";
import { applyFilePatch, parseUnifiedDiff } from "../lib/unifiedDiff";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

/**
 * Recover the file path from an `edit`/`multi_edit` call.
 *
 * Models routinely emit the path under a different key — `file_path`,
 * `filename`, `file`, `target` — or, when `old_string`/`new_string` are huge,
 * drop the leading `path` field entirely. The strict `z.string()` schema then
 * threw "Invalid input for tool edit: Type validation failed", a red card the
 * agent read as a corrupt session and retried blindly. Normalising aliases
 * first means the common misspellings just work; a genuinely absent path
 * falls through to a plain error result (see the execute guard) the model can
 * correct on the next step instead of a hard SDK rejection.
 */
const PATH_KEYS = [
  "path",
  "file_path",
  "filepath",
  "file",
  "filename",
  "target",
  "target_path",
];

function pickPath(obj: Record<string, unknown>): string | undefined {
  for (const k of PATH_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function normalizeEditInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = { ...(input as Record<string, unknown>) };
  if (typeof obj.path !== "string" || !obj.path.trim()) {
    const p = pickPath(obj);
    if (p) obj.path = p;
  }
  return obj;
}

type EditResult =
  | {
      ok: true;
      replacements: number;
      bytesWritten: number;
      path: string;
      /** The exact match drifted and a unique whitespace-insensitive one was
       *  used (typical after an auto-format reflowed the file). */
      looseMatch?: true;
    }
  | { error: string; path: string };

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * File access for one edit. Injected so the same matching, counting and
 * plan-mode logic serves a local file and a remote one - duplicating it per
 * transport is how the two drift apart.
 */
type EditIo = {
  read: (path: string) => ReturnType<typeof native.readFile>;
  write: (path: string, content: string) => Promise<void>;
  remote: boolean;
  /** Cache key for this path, namespaced by the machine it lives on. */
  cacheKey: (path: string) => string;
};

const LOCAL_IO: EditIo = {
  read: (p) => native.readFile(p),
  write: (p, c) => native.writeFile(p, c),
  remote: false,
  cacheKey: (p) => fileCacheKey(p),
};

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Whitespace-insensitive spans of `needle` inside `content`, mapped back to
 * original offsets.
 *
 * The verification formatter reflows a file after each accepted edit - it
 * joins a multi-line call onto one line, re-indents, breaks arguments - so an
 * `old_string` copied from an earlier read can drift out of sync with the
 * file even when the agent quoted it faithfully. Every miss pays a re-read
 * round trip. As a fallback the matcher strips ALL whitespace (newlines too)
 * from both sides and maps a hit back to its real span. The bar stays the
 * exact matcher's: a lone unique hit may apply, several are refused as
 * ambiguous, none falls through to the grounding diagnostic. Exact matching
 * always runs first, so this path can never win against a real exact hit.
 */
export function findLooseSpans(
  content: string,
  needle: string,
  limit = 60,
): { start: number; end: number }[] {
  const map: number[] = [];
  const chars: string[] = [];
  for (let i = 0; i < content.length; i++) {
    if (!/\s/.test(content[i])) {
      chars.push(content[i]);
      map.push(i);
    }
  }
  const strippedContent = chars.join("");
  const strippedNeedle: string[] = [];
  for (const ch of needle) {
    if (!/\s/.test(ch)) strippedNeedle.push(ch);
  }
  const target = strippedNeedle.join("");
  if (target.length === 0) return [];
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  while (spans.length <= limit) {
    const at = strippedContent.indexOf(target, from);
    if (at === -1) break;
    spans.push({
      start: map[at],
      end: map[at + target.length - 1] + 1,
    });
    from = at + target.length;
  }
  return spans;
}

/** Re-line-break an inserted string to match the file's dominant EOL. */
function toFileEol(text: string, content: string): string {
  return content.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text;
}

/**
 * Generates actionable grounding diagnostics when `old_string` fails to match.
 * Pinpoints line endings, casing, whitespace/indentation shifts, or closest
 * matching line blocks so the agent can self-repair its edit arguments.
 */
export function diagnoseMismatch(content: string, target: string): string {
  if (!target || !content) {
    return `old_string not found: ${JSON.stringify(target.slice(0, 80))}. Grounding check: re-read the file with read_file to inspect the current lines, indentation, and whitespace verbatim.`;
  }

  const contentLf = content.replace(/\r\n/g, "\n");
  const targetLf = target.replace(/\r\n/g, "\n");

  // 1. Line-ending discrepancy
  if (contentLf.includes(targetLf)) {
    return `old_string not found (line-ending mismatch: file uses \\r\\n while target uses \\n or vice versa). Grounding check: re-read the file with read_file to inspect verbatim line endings.`;
  }

  // 2. Case-insensitive match
  const lowerContent = contentLf.toLowerCase();
  const lowerTarget = targetLf.toLowerCase();
  const caseIdx = lowerContent.indexOf(lowerTarget);
  if (caseIdx !== -1) {
    const lineNum = contentLf.slice(0, caseIdx).split("\n").length;
    const actualSnippet = contentLf.slice(caseIdx, caseIdx + targetLf.length);
    return `old_string not found: ${JSON.stringify(target.slice(0, 80))}. Grounding check: case mismatch near line ${lineNum}. Verbatim content in file: ${JSON.stringify(actualSnippet.slice(0, 100))}. Copy the verbatim characters.`;
  }

  // 3. Whitespace / indentation discrepancy
  const targetWsNorm = normalizeWhitespace(targetLf);
  const lines = contentLf.split("\n");
  const targetLines = targetLf.split("\n");
  const targetLineCount = targetLines.length;

  for (let i = 0; i <= lines.length - targetLineCount; i++) {
    const windowSlice = lines.slice(i, i + targetLineCount);
    const windowText = windowSlice.join("\n");
    if (normalizeWhitespace(windowText) === targetWsNorm) {
      const startLine = i + 1;
      const endLine = i + targetLineCount;
      return `old_string not found: ${JSON.stringify(target.slice(0, 80))}. Grounding check: indentation/whitespace mismatch at lines ${startLine}-${endLine}. Verbatim content in file:\n${windowText}\nCopy this exact verbatim string.`;
    }
  }

  // 4. Partial / starting line anchor match
  const firstTargetLine = targetLines[0]?.trim();
  if (firstTargetLine && firstTargetLine.length >= 4) {
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i].trim() === firstTargetLine ||
        lines[i].includes(firstTargetLine)
      ) {
        const startLine = i + 1;
        const windowSlice = lines.slice(
          i,
          Math.min(lines.length, i + Math.max(3, targetLineCount)),
        );
        return `old_string not found: ${JSON.stringify(target.slice(0, 80))}. Grounding check: anchor match found starting at line ${startLine}. Verbatim content in file:\n${windowSlice.join("\n")}\nRe-read with read_file or copy the verbatim lines above.`;
      }
    }
  }

  return `old_string not found: ${JSON.stringify(target.slice(0, 80))}. Grounding check: re-read the file with read_file to inspect the current lines, indentation, and whitespace verbatim.`;
}

async function applyEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
  kind: "edit" | "multi_edit",
  readCache: Map<string, { size: number; hash: number }>,
  io: EditIo = LOCAL_IO,
): Promise<EditResult> {
  const r = await io.read(abs);
  if (r.kind === "binary") return { error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;
  let content = original;
  let totalReplacements = 0;
  let usedLoose = false;

  for (const e of edits) {
    if (e.old_string === e.new_string) {
      return {
        error: "old_string and new_string are identical",
        path: abs,
      };
    }
    if (e.old_string.length === 0) {
      return { error: "old_string cannot be empty", path: abs };
    }

    let targetOld = e.old_string;
    let targetNew = e.new_string;

    // Line-ending reconciliation: if exact match fails, normalize line endings to find the match.
    if (content.indexOf(targetOld) === -1) {
      const normalizedOld = targetOld.replace(/\r\n/g, "\n");
      const crlfOld = normalizedOld.replace(/\n/g, "\r\n");
      if (content.includes(crlfOld)) {
        targetOld = crlfOld;
        targetNew = targetNew.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      } else if (content.includes(normalizedOld)) {
        targetOld = normalizedOld;
        targetNew = targetNew.replace(/\r\n/g, "\n");
      }
    }

    if (e.replace_all) {
      const before = content;
      content = content.split(targetOld).join(targetNew);
      const occurrences =
        (before.length - content.length) /
          (targetOld.length - targetNew.length || 1) || 0;
      // Recover count via direct search to avoid divide-by-zero edge cases.
      let n = 0;
      let i = 0;
      while (true) {
        const found = before.indexOf(targetOld, i);
        if (found === -1) break;
        n++;
        i = found + targetOld.length;
      }
      if (n === 0) {
        const spans = findLooseSpans(content, targetOld);
        if (spans.length > 60) {
          // The scanner stops at limit+1, so more hits than that means it
          // cannot promise to have found them all. Replacing a subset and
          // reporting a partial count as success is the silent corruption
          // this fallback exists to avoid; refuse and let the caller scope it.
          return {
            error:
              "replace_all: the whitespace-loose fallback matched more than 60 places. Provide a more specific old_string.",
            path: abs,
          };
        }
        if (spans.length > 0) {
          usedLoose = true;
          const insert = toFileEol(targetNew, content);
          for (let s = spans.length - 1; s >= 0; s--) {
            content =
              content.slice(0, spans[s].start) +
              insert +
              content.slice(spans[s].end);
          }
          totalReplacements += spans.length;
          continue;
        }
        const cacheEntry = readCache.get(io.cacheKey(abs));
        if (cacheEntry) cacheEntry.hash = -1;
        return {
          error: diagnoseMismatch(content, e.old_string),
          path: abs,
        };
      }
      totalReplacements += n;
      void occurrences;
    } else {
      const first = content.indexOf(targetOld);
      if (first === -1) {
        const spans = findLooseSpans(content, e.old_string);
        if (spans.length > 1) {
          return {
            error:
              "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
            path: abs,
          };
        }
        if (spans.length === 1) {
          usedLoose = true;
          content =
            content.slice(0, spans[0].start) +
            toFileEol(targetNew, content) +
            content.slice(spans[0].end);
          totalReplacements += 1;
          continue;
        }
        const cacheEntry = readCache.get(io.cacheKey(abs));
        if (cacheEntry) cacheEntry.hash = -1;
        return {
          error: diagnoseMismatch(content, e.old_string),
          path: abs,
        };
      }
      const second = content.indexOf(targetOld, first + 1);
      if (second !== -1) {
        return {
          error:
            "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
          path: abs,
        };
      }
      content =
        content.slice(0, first) +
        targetNew +
        content.slice(first + targetOld.length);
      totalReplacements += 1;
    }
  }

  if (usePlanStore.getState().active) {
    usePlanStore.getState().enqueue({
      id: newQueuedEditId(),
      kind,
      path: abs,
      originalContent: original,
      proposedContent: content,
      isNewFile: false,
    });
    return {
      ok: true,
      replacements: totalReplacements,
      bytesWritten: content.length,
      path: abs,
      ...(usedLoose ? { looseMatch: true as const } : {}),
    };
  }

  try {
    await io.write(abs, content);
    readCache.set(io.cacheKey(abs), {
      size: content.length,
      hash: djb2(content),
    });
    return {
      ok: true,
      replacements: totalReplacements,
      bytesWritten: content.length,
      path: abs,
      ...(usedLoose ? { looseMatch: true as const } : {}),
    };
  } catch (err) {
    return { error: String(err), path: abs };
  }
}

/**
 * Resolve an edit target, refusing rather than silently editing the wrong
 * machine. A remote edit reads and writes over SFTP; the canonicalize step is
 * skipped because it is a local-filesystem call, and the remote host enforces
 * its own permissions anyway.
 */
async function resolveEditTarget(
  ctx: ToolContext,
  path: string,
): Promise<
  { ok: true; abs: string; io: EditIo } | { ok: false; error: EditResult }
> {
  const target = routePath(ctx.getRemoteSession(), path, (p) =>
    resolvePath(p, ctx.getCwd()),
  );
  if (target.kind === "error") {
    return { ok: false, error: { error: target.reason, path } };
  }
  if (target.kind === "remote") {
    const safety = checkWritable(target.path);
    if (!safety.ok) {
      return { ok: false, error: { error: safety.reason, path: target.path } };
    }
    const sessionId = target.sessionId;
    return {
      ok: true,
      abs: target.path,
      io: {
        read: async (p) => {
          const content = await sftpReadFile(sessionId, p);
          return { kind: "text", content, size: content.length } as Awaited<
            ReturnType<typeof native.readFile>
          >;
        },
        write: (p, c) => sftpWriteFile(sessionId, p, c),
        remote: true,
        cacheKey: (p) => fileCacheKey(p, sessionId),
      },
    };
  }
  const safety = await checkWritableCanonical(target.path, native.canonicalize);
  if (!safety.ok) {
    return { ok: false, error: { error: safety.reason, path: target.path } };
  }
  return { ok: true, abs: safety.canonical, io: LOCAL_IO };
}

export function buildEditTools(ctx: ToolContext) {
  return {
    edit: tool({
      description:
        "Replace an exact string in a file. `old_string` must be unique in the file unless `replace_all: true`. If the exact text drifted (an auto-format reflowed the file since your last read), a unique whitespace-insensitive match is applied as a fallback and reported as `looseMatch`; an ambiguous or absent match still errors with the grounding diagnostic. Asks for user approval before writing. Always include `path`.",
      inputSchema: z.preprocess(
        normalizeEditInput,
        z.object({
          // Optional so a model that drops the key (the huge old/new strings
          // crowd it out) yields a plain error result the next step can fix,
          // not a hard SDK validation rejection that reads as a corrupt tool.
          path: z
            .string()
            .optional()
            .describe("File to edit (absolute, or relative to the cwd)."),
          old_string: z
            .string()
            .describe(
              "Exact substring to replace. Must be unique unless replace_all.",
            ),
          new_string: z.string().describe("Replacement substring."),
          replace_all: z.boolean().optional(),
        }),
      ),
      needsApproval: true,
      execute: async ({ path, old_string, new_string, replace_all }) => {
        if (!path?.trim()) {
          return {
            error: "missing `path` - name the file to edit.",
            path: "",
          };
        }
        const resolved = await resolveEditTarget(ctx, path);
        if (!resolved.ok) return resolved.error;
        const { abs, io } = resolved;
        const cacheKey = io.cacheKey(abs);
        if (!ctx.readCache.has(cacheKey)) {
          try {
            const r = await io.read(abs);
            if (r.kind === "text") {
              ctx.readCache.set(cacheKey, {
                size: r.size,
                hash: djb2(r.content),
              });
            }
          } catch {
            // Ignore - applyEdits handles read failures cleanly
          }
        }
        return applyEdits(
          abs,
          [{ old_string, new_string, replace_all }],
          "edit",
          ctx.readCache,
          io,
        );
      },
    }),

    multi_edit: tool({
      description:
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing. Each edit accepts the same unique whitespace-insensitive fallback as `edit` after an auto-format drift. Asks for user approval before writing. Always include `path`.",
      inputSchema: z.preprocess(
        normalizeEditInput,
        z.object({
          path: z.string().optional(),
          edits: z
            .array(
              z.object({
                old_string: z.string(),
                new_string: z.string(),
                replace_all: z.boolean().optional(),
              }),
            )
            .min(1),
        }),
      ),
      needsApproval: true,
      execute: async ({ path, edits }) => {
        if (!path?.trim()) {
          return {
            error: "missing `path` - name the file to edit.",
            path: "",
          };
        }
        const resolved = await resolveEditTarget(ctx, path);
        if (!resolved.ok) return resolved.error;
        const { abs, io } = resolved;
        const cacheKey = io.cacheKey(abs);
        if (!ctx.readCache.has(cacheKey)) {
          try {
            const r = await io.read(abs);
            if (r.kind === "text") {
              ctx.readCache.set(cacheKey, {
                size: r.size,
                hash: djb2(r.content),
              });
            }
          } catch {
            // Ignore - applyEdits handles read failures cleanly
          }
        }
        return applyEdits(abs, edits, "multi_edit", ctx.readCache, io);
      },
    }),

    apply_patch: tool({
      description:
        "Apply a unified diff to one or more files. Preferred over a chain of edit calls for a multi-hunk or multi-file change: each hunk carries its own context, so it lands exactly where written or fails loudly instead of guessing. Every file is read and every hunk matched BEFORE anything is written, so a bad hunk changes nothing. Accepts the standard `--- a/path` / `+++ b/path` / `@@ ... @@` format; `--- /dev/null` creates a file. Local or remote. Asks for user approval.",
      inputSchema: z.object({
        patch: z
          .string()
          .min(1)
          .describe(
            "Unified diff text. Use paths relative to the workspace cwd (the a/ and b/ prefixes are stripped).",
          ),
      }),
      needsApproval: true,
      execute: async ({ patch }) => {
        const parsed = parseUnifiedDiff(patch);
        if (parsed.error) return { error: parsed.error };

        type Staged = {
          path: string;
          abs: string;
          content: string;
          io: EditIo;
          added: number;
          removed: number;
        };
        const stagedByAbs = new Map<string, Staged>();

        // Read + apply every hunk in memory first, so a mismatch anywhere leaves
        // the workspace untouched rather than half-patched. Two headers naming
        // the same file merge, so the second hunk set applies to the first set's
        // result instead of re-reading the original content and losing it.
        for (const file of parsed.files) {
          if (file.newPath === "/dev/null") {
            return {
              error: `apply_patch does not delete files (${file.oldPath}); use delete_file.`,
              file: file.oldPath,
            };
          }
          const rel =
            file.newPath && file.newPath !== "/dev/null"
              ? file.newPath
              : file.oldPath;
          const resolved = await resolveEditTarget(ctx, rel);
          if (!resolved.ok) return { ...resolved.error, file: rel };
          const { abs, io } = resolved;

          const existing = stagedByAbs.get(abs);
          let content = existing?.content ?? "";
          if (!existing && file.oldPath !== "/dev/null") {
            try {
              const r = await io.read(abs);
              if (r.kind !== "text") {
                return { error: `cannot patch ${rel}: not a text file`, file: rel };
              }
              content = r.content;
            } catch (e) {
              return { error: `cannot read ${rel}: ${String(e)}`, file: rel };
            }
          }
          const applied = applyFilePatch(content, file);
          if (!applied.ok) {
            return { error: `patch failed for ${rel}: ${applied.error}`, file: rel };
          }
          const added = file.hunks.reduce(
            (n, h) => n + h.lines.filter((l) => l.type === "add").length,
            0,
          );
          const removed = file.hunks.reduce(
            (n, h) => n + h.lines.filter((l) => l.type === "remove").length,
            0,
          );
          if (existing) {
            existing.content = applied.content;
            existing.added += added;
            existing.removed += removed;
          } else {
            stagedByAbs.set(abs, {
              path: rel,
              abs,
              content: applied.content,
              io,
              added,
              removed,
            });
          }
        }
        const staged = [...stagedByAbs.values()];

        const files: Array<{ path: string; added: number; removed: number }> = [];
        for (const item of staged) {
          try {
            await item.io.write(item.abs, item.content);
            ctx.readCache.set(item.io.cacheKey(item.abs), {
              size: item.content.length,
              hash: djb2(item.content),
            });
            files.push({
              path: item.path,
              added: item.added,
              removed: item.removed,
            });
          } catch (e) {
            return {
              error: `wrote ${files.length} of ${staged.length} file(s), then failed on ${item.path}: ${String(e)}`,
              files,
            };
          }
        }
        return { changed: files.length, files };
      },
    }),
  } as const;
}
