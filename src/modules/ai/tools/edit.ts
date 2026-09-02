import { sftpReadFile, sftpWriteFile } from "@/modules/ssh/sftp";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { fileCacheKey, routePath } from "../lib/remoteFs";
import { checkWritable, checkWritableCanonical } from "../lib/security";
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
  | { ok: true; replacements: number; bytesWritten: number; path: string }
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
    if (e.replace_all) {
      const before = content;
      content = content.split(e.old_string).join(e.new_string);
      const occurrences =
        (before.length - content.length) /
          (e.old_string.length - e.new_string.length || 1) || 0;
      // Recover count via direct search to avoid divide-by-zero edge cases.
      let n = 0;
      let i = 0;
      while (true) {
        const found = before.indexOf(e.old_string, i);
        if (found === -1) break;
        n++;
        i = found + e.old_string.length;
      }
      if (n === 0) {
        return {
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}`,
          path: abs,
        };
      }
      totalReplacements += n;
      void occurrences;
    } else {
      const first = content.indexOf(e.old_string);
      if (first === -1) {
        return {
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}`,
          path: abs,
        };
      }
      const second = content.indexOf(e.old_string, first + 1);
      if (second !== -1) {
        return {
          error:
            "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
          path: abs,
        };
      }
      content =
        content.slice(0, first) +
        e.new_string +
        content.slice(first + e.old_string.length);
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
        "Replace an exact string in a file. Requires read_file on this path first in the current session — this prevents blind edits. `old_string` must be unique in the file unless `replace_all: true`. Asks for user approval before writing. Always include `path`.",
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
        if (!path || !path.trim()) {
          return {
            error:
              "missing `path` — name the file to edit (and read_file it first).",
            path: "",
          };
        }
        const resolved = await resolveEditTarget(ctx, path);
        if (!resolved.ok) return resolved.error;
        const { abs, io } = resolved;
        if (!ctx.readCache.has(io.cacheKey(abs))) {
          return {
            error:
              "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
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
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing. Requires prior read_file on the path. Asks for user approval before writing. Always include `path`.",
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
        if (!path || !path.trim()) {
          return {
            error:
              "missing `path` — name the file to edit (and read_file it first).",
            path: "",
          };
        }
        const resolved = await resolveEditTarget(ctx, path);
        if (!resolved.ok) return resolved.error;
        const { abs, io } = resolved;
        if (!ctx.readCache.has(io.cacheKey(abs))) {
          return {
            error:
              "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
        }
        return applyEdits(abs, edits, "multi_edit", ctx.readCache, io);
      },
    }),
  } as const;
}
