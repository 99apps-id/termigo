import { tool } from "ai";
import { z } from "zod";
import {
  sftpCreateDir,
  sftpReadDir,
  sftpReadFile,
  sftpWriteFile,
} from "@/modules/ssh/sftp";
import { native } from "../lib/native";
import {
  checkReadable,
  checkReadableCanonical,
  checkWritable,
  checkWritableCanonical,
} from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { fileCacheKey, routePath } from "../lib/remoteFs";
import {
  resolvePath,
  resolveRemotePath,
  type RemoteFsSession,
  type ToolContext,
} from "./context";

const READ_BYTE_CAP = 25 * 1024;
const READ_LINE_CAP = 2000;

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Slice file content to the read tool's line/byte caps. Shared by the local
 *  and remote read paths so both honour identical limits. */
function sliceLines(
  content: string,
  offset: number | undefined,
  limit: number | undefined,
): {
  content: string;
  total_lines: number;
  start_line?: number;
  end_line?: number;
  truncated: boolean;
} {
  const lines = content.split("\n");
  const isFullRead = offset === undefined && limit === undefined;
  if (isFullRead) {
    const sliceEnd = Math.min(lines.length, READ_LINE_CAP);
    let c = lines.slice(0, sliceEnd).join("\n");
    let truncated = sliceEnd < lines.length;
    if (c.length > READ_BYTE_CAP) {
      c = c.slice(0, READ_BYTE_CAP);
      truncated = true;
    }
    return { content: c, total_lines: lines.length, truncated };
  }
  const start = offset ?? 0;
  const requested = limit ?? READ_LINE_CAP;
  const end = Math.min(lines.length, start + requested);
  let c = lines.slice(start, end).join("\n");
  let truncated = end < lines.length;
  if (c.length > READ_BYTE_CAP) {
    c = c.slice(0, READ_BYTE_CAP);
    truncated = true;
  }
  return {
    content: c,
    total_lines: lines.length,
    start_line: start,
    end_line: end,
    truncated,
  };
}

/** Read a file on the active SSH session's remote host over SFTP. The
 *  deny-list still applies to the remote path; only the canonicalize step is
 *  skipped (it is a local-fs call, and the remote kernel enforces the real
 *  permissions). */
async function readRemoteFile(
  remote: RemoteFsSession,
  remotePath: string,
  offset: number | undefined,
  limit: number | undefined,
  readCache: Map<string, { size: number; hash: number }>,
) {
  const safety = checkReadable(remotePath);
  if (!safety.ok) return { error: safety.reason, path: remotePath };
  try {
    const content = await sftpReadFile(remote.sessionId, remotePath);
    const size = content.length;
    const hash = djb2(content);
    const isFullRead = offset === undefined && limit === undefined;
    const key = fileCacheKey(remotePath, remote.sessionId);
    const prior = readCache.get(key);
    if (isFullRead && prior && prior.size === size && prior.hash === hash) {
      return { path: remotePath, unchanged: true, size };
    }
    readCache.set(key, { size, hash });
    const sliced = sliceLines(content, offset, limit);
    return {
      path: remotePath,
      content: sliced.content,
      size,
      total_lines: sliced.total_lines,
      ...(sliced.start_line !== undefined
        ? { start_line: sliced.start_line, end_line: sliced.end_line }
        : {}),
      ...(sliced.truncated
        ? {
            truncated: true,
            ...(isFullRead
              ? { hint: "call read_file with offset to continue" }
              : {}),
          }
        : {}),
    };
  } catch (e) {
    return { error: String(e), path: remotePath };
  }
}

export function buildFsTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file. Defaults to the first 2000 lines (capped at 25KB). Pass `offset`/`limit` for line-based windowing of large files. Refuses binary, oversized, or sensitive files (.env, keys, credentials). If you call this on the same path twice in a session without edits in between, the second call returns `unchanged: true` instead of re-emitting the content — re-read the prior tool result. When the active terminal is an SSH session, paths resolve on the remote host (POSIX) and reads go over SFTP; Windows drive paths (C:\...) still read locally.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based start line. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max lines to return. Default 2000."),
      }),
      execute: async ({ path, offset, limit }) => {
        // Active SSH terminal: reads go to the remote host over SFTP. Absolute
        // POSIX + relative paths resolve remotely; Windows drive paths (C:\...)
        // fall through to the local filesystem below.
        const remote = ctx.getRemoteSession();
        if (remote) {
          const remotePath = resolveRemotePath(path, remote.cwd);
          if (remotePath !== null) {
            return readRemoteFile(remote, remotePath, offset, limit, ctx.readCache);
          }
        }
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const r = await native.readFile(abs);
          if (r.kind === "binary")
            return { error: "binary file refused", path: abs, size: r.size };
          if (r.kind === "toolarge")
            return {
              error: `file too large (${r.size} bytes, limit ${r.limit})`,
              path: abs,
            };

          const hash = djb2(r.content);
          const isFullRead = offset === undefined && limit === undefined;
          const prior = ctx.readCache.get(abs);
          if (isFullRead && prior && prior.size === r.size && prior.hash === hash) {
            return { path: abs, unchanged: true, size: r.size };
          }
          ctx.readCache.set(abs, { size: r.size, hash });

          const sliced = sliceLines(r.content, offset, limit);
          return {
            path: abs,
            content: sliced.content,
            size: r.size,
            total_lines: sliced.total_lines,
            ...(sliced.start_line !== undefined
              ? { start_line: sliced.start_line, end_line: sliced.end_line }
              : {}),
            ...(sliced.truncated
              ? {
                  truncated: true,
                  ...(isFullRead
                    ? { hint: "call read_file with offset to continue" }
                    : {}),
                }
              : {}),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries (files + directories) in a directory. Hidden entries are omitted. When the active terminal is an SSH session, the directory is listed on the remote host over SFTP (POSIX paths); Windows drive paths (C:\...) still list locally.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        // Active SSH terminal: list the remote host over SFTP (see read_file).
        const remote = ctx.getRemoteSession();
        if (remote) {
          const remotePath = resolveRemotePath(path, remote.cwd);
          if (remotePath !== null) {
            const safety = checkReadable(remotePath);
            if (!safety.ok) return { error: safety.reason, path: remotePath };
            try {
              const entries = await sftpReadDir(remote.sessionId, remotePath, false);
              return {
                path: remotePath,
                entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
              };
            } catch (e) {
              return { error: String(e), path: remotePath };
            }
          }
        }
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const entries = await native.readDir(abs);
          return {
            path: abs,
            entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a file with the given content. Always asks the user before running. Prefer `edit` / `multi_edit` for in-place changes — only use `write_file` for creating a brand-new file or fully replacing a tiny one.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path, content }) => {
        // Writes follow reads onto the remote host. Leaving them local was the
        // dangerous half of the original state: the agent could read a remote
        // file and write the edit to this machine, with nothing saying so.
        const target = routePath(ctx.getRemoteSession(), path, (p) =>
          resolvePath(p, ctx.getCwd()),
        );
        if (target.kind === "error") return { error: target.reason, path };
        if (target.kind === "remote") {
          const safety = checkWritable(target.path);
          if (!safety.ok) return { error: safety.reason, path: target.path };
          try {
            await sftpWriteFile(target.sessionId, target.path, content);
            return {
              path: target.path,
              remote: true,
              bytesWritten: content.length,
              ok: true,
            };
          } catch (e) {
            return { error: String(e), path: target.path, remote: true };
          }
        }

        const reqPath = target.path;
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        if (usePlanStore.getState().active) {
          let original = "";
          let isNewFile = false;
          try {
            const r = await native.readFile(abs);
            if (r.kind === "text") original = r.content;
          } catch {
            isNewFile = true;
          }
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "write_file",
            path: abs,
            originalContent: original,
            proposedContent: content,
            isNewFile,
          });
          return {
            path: abs,
            queued_for_plan_review: true,
            ok: true,
          };
        }

        try {
          await native.writeFile(abs, content);
          ctx.readCache.set(abs, { size: content.length, hash: djb2(content) });
          return { path: abs, bytesWritten: content.length, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    create_directory: tool({
      description:
        "Create a directory (and any missing parents). Always asks the user before running.",
      inputSchema: z.object({
        path: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path }) => {
        const target = routePath(ctx.getRemoteSession(), path, (p) =>
          resolvePath(p, ctx.getCwd()),
        );
        if (target.kind === "error") return { error: target.reason, path };
        if (target.kind === "remote") {
          const safety = checkWritable(target.path);
          if (!safety.ok) return { error: safety.reason, path: target.path };
          try {
            await sftpCreateDir(target.sessionId, target.path);
            return { path: target.path, remote: true, ok: true };
          } catch (e) {
            return { error: String(e), path: target.path, remote: true };
          }
        }

        const reqPath = target.path;
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "create_directory",
            path: abs,
            originalContent: "",
            proposedContent: "",
            isNewFile: true,
            description: "Create directory",
          });
          return { path: abs, queued_for_plan_review: true, ok: true };
        }
        try {
          await native.createDir(abs);
          return { path: abs, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),
  } as const;
}
