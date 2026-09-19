import {
  sftpCreateDir,
  sftpReadDir,
  sftpReadFile,
  sftpWriteFile,
} from "@/modules/ssh/sftp";
import { tool } from "ai";
import { z } from "zod";
import { modelSupportsVision } from "../config";
import { scanTextForConflicts, summarizeConflicts } from "../lib/conflicts";
import { native } from "../lib/native";
import { fileCacheKey, routePath } from "../lib/remoteFs";
import {
  checkReadable,
  checkReadableCanonical,
  checkWritable,
  checkWritableCanonical,
} from "../lib/security";
import { useArtifactsStore } from "../store/artifactsStore";
import { useChatStore } from "../store/chatStore";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import {
  type RemoteFsSession,
  resolvePath,
  type ToolContext,
} from "./context";

export const READ_BYTE_CAP = 64 * 1024;
export const READ_LINE_CAP = 2000;

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

/** Shape of a read_file result that carried an image back for a vision model. */
type ImageReadOutput = {
  path: string;
  kind: "image";
  mediaType: string;
  data: string;
  size: number;
};


function isImageReadOutput(o: unknown): o is ImageReadOutput {
  return (
    !!o &&
    typeof o === "object" &&
    (o as { kind?: unknown }).kind === "image" &&
    typeof (o as { data?: unknown }).data === "string"
  );
}

/** Slice file content to the read tool's line/byte caps. Shared by the local
 *  and remote read paths so both honour identical limits. */
export function sliceLines(
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
  force?: boolean,
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
    if (!force && isFullRead && prior && prior.size === size && prior.hash === hash) {
      return {
        path: remotePath,
        unchanged: true,
        size,
        hint: "File content unchanged from prior read. Pass force: true or offset: 0 to re-read full content.",
      };
    }
    readCache.set(key, { size, hash });
    const sliced = sliceLines(content, offset, limit);
    const conflicts = summarizeConflicts(
      scanTextForConflicts(sliced.content, (sliced.start_line ?? 0) + 1),
    );
    return {
      path: remotePath,
      content: sliced.content,
      size,
      total_lines: sliced.total_lines,
      ...(sliced.start_line !== undefined
        ? { start_line: sliced.start_line, end_line: sliced.end_line }
        : {}),
      ...(conflicts.length > 0
        ? {
            conflicts,
            conflictWarning: `This file contains ${conflicts.length} unresolved git merge conflict block(s).`,
          }
        : {}),
      ...(sliced.truncated
        ? {
            truncated: true,
            hint: isFullRead
              ? "call read_file with offset and limit to continue reading remaining lines (e.g. offset: 500, limit: 500)"
              : "call read_file with next offset to continue",
          }
        : {}),
    };
  } catch (e) {
    return { error: String(e), path: remotePath };
  }
}

const WRITE_PATH_KEYS = [
  "path",
  "file_path",
  "filepath",
  "file",
  "filename",
  "target",
  "target_path",
];

const WRITE_CONTENT_KEYS = [
  "content",
  "contents",
  "text",
  "body",
  "data",
  "code",
];

export function normalizeWriteFileInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = { ...(input as Record<string, unknown>) };
  if (typeof obj.path !== "string" || !obj.path.trim()) {
    for (const k of WRITE_PATH_KEYS) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) {
        obj.path = v;
        break;
      }
    }
  }
  if (typeof obj.content !== "string") {
    for (const k of WRITE_CONTENT_KEYS) {
      const v = obj[k];
      if (typeof v === "string") {
        obj.content = v;
        break;
      }
    }
  }
  return obj;
}

export function buildFsTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file. Defaults to the first 2000 lines (capped at 64KB). Pass `offset`/`limit` for line-based windowing of large files. Refuses other binary, oversized, or sensitive files (.env, keys, credentials). IMAGES (png, jpeg, gif, webp) are returned as a picture you can actually see - call this on a screenshot, mockup, or diagram to look at it (requires a vision-capable model; local files only). If you call this on the same path twice in a session without edits in between, the second call returns `unchanged: true` instead of re-emitting the content - re-read the prior tool result. When the active terminal is an SSH session, paths resolve on the remote host (POSIX) and reads go over SFTP; Windows drive paths (C:...) still read locally.",
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
        force: z
          .boolean()
          .optional()
          .describe(
            "Set true to force re-reading the full content even if unchanged since last read.",
          ),
      }),
      execute: async ({ path, offset, limit, force }) => {
        const target = routePath(ctx.getRemoteSession(), path, (p) =>
          resolvePath(p, ctx.getCwd()),
        );
        if (target.kind === "error") return { error: target.reason, path };
        if (target.kind === "remote") {
          return readRemoteFile(
            {
              sessionId: target.sessionId,
              cwd: ctx.getRemoteSession()?.cwd ?? null,
            },
            target.path,
            offset,
            limit,
            ctx.readCache,
            force,
          );
        }
        const reqPath = target.path;
        const safety = await checkReadableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        // Images: hand the raw bytes to the model as a visual part (see
        // `toModelOutput` below) instead of refusing them as "binary" — but only
        // when the selected model can actually see, and only for local files
        // (SFTP image reads are not wired up).
        if (isImagePath(abs)) {
          const modelId = useChatStore.getState().selectedModelId;
          if (!modelSupportsVision(modelId)) {
            return {
              error:
                "this file is an image, but the selected model has no vision capability — switch to a vision-capable model to read it.",
              path: abs,
            };
          }
          try {
            const img = await native.readImageBase64(abs);
            return {
              path: abs,
              kind: "image" as const,
              mediaType: img.media_type,
              data: img.data,
              size: img.size,
            };
          } catch (e) {
            return { error: String(e), path: abs };
          }
        }

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
          if (
            !force &&
            isFullRead &&
            prior &&
            prior.size === r.size &&
            prior.hash === hash
          ) {
            return {
              path: abs,
              unchanged: true,
              size: r.size,
              hint: "File content unchanged from prior read. Pass force: true or offset: 0 to re-read full content.",
            };
          }
          ctx.readCache.set(abs, { size: r.size, hash });

          const sliced = sliceLines(r.content, offset, limit);
          const conflicts = summarizeConflicts(
            scanTextForConflicts(sliced.content, (sliced.start_line ?? 0) + 1),
          );
          return {
            path: abs,
            content: sliced.content,
            size: r.size,
            total_lines: sliced.total_lines,
            ...(sliced.start_line !== undefined
              ? { start_line: sliced.start_line, end_line: sliced.end_line }
              : {}),
            ...(conflicts.length > 0
              ? {
                  conflicts,
                  conflictWarning: `This file contains ${conflicts.length} unresolved git merge conflict block(s).`,
                }
              : {}),
            ...(sliced.truncated
              ? {
                  truncated: true,
                  hint: isFullRead
                    ? "call read_file with offset and limit to continue reading remaining lines (e.g. offset: 500, limit: 500)"
                    : "call read_file with next offset to continue",
                }
              : {}),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
      // When read_file returned an image, feed it to the model as a real visual
      // part (image-data) rather than a JSON blob of base64 it cannot see. Every
      // other result stays plain JSON.
      toModelOutput: ({ output }) => {
        if (isImageReadOutput(output)) {
          return {
            type: "content",
            value: [
              {
                type: "text",
                text: `Image ${output.path} (${output.mediaType}, ${output.size} bytes)`,
              },
              {
                type: "image-data",
                data: output.data,
                mediaType: output.mediaType,
              },
            ],
          };
        }
        return { type: "json", value: output as never };
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries (files + directories) in a directory. Hidden entries are omitted. When the active terminal is an SSH session, the directory is listed on the remote host over SFTP (POSIX paths); Windows drive paths (C:...) still list locally.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const target = routePath(ctx.getRemoteSession(), path, (p) =>
          resolvePath(p, ctx.getCwd()),
        );
        if (target.kind === "error") return { error: target.reason, path };
        if (target.kind === "remote") {
          const safety = checkReadable(target.path);
          if (!safety.ok) return { error: safety.reason, path: target.path };
          try {
            const entries = await sftpReadDir(
              target.sessionId,
              target.path,
              false,
            );
            return {
              path: target.path,
              entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
            };
          } catch (e) {
            return { error: String(e), path: target.path };
          }
        }
        const reqPath = target.path;
        const safety = await checkReadableCanonical(
          reqPath,
          native.canonicalize,
        );
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
        "Create or overwrite a file with the given content. Always asks the user before running. Prefer edit / multi_edit for in-place changes; use write_file for creating new files, reports, or fully replacing a file.",
      inputSchema: z.preprocess(
        normalizeWriteFileInput,
        z.object({
          path: z.string().describe("File path (absolute or relative to cwd)."),
          content: z.string().describe("File content to write."),
          overwrite: z
            .boolean()
            .optional()
            .describe(
              "Explicitly permit overwriting an existing file. Default true for write_file.",
            ),
        }),
      ),
      needsApproval: true,
      execute: async (rawArgs) => {
        const input = (normalizeWriteFileInput(rawArgs) ?? {}) as {
          path?: string;
          content?: string;
          overwrite?: boolean;
        };
        const path = input.path;
        // Fail closed on a missing content field: defaulting it to "" lets a
        // model slip (or an alias miss) silently wipe a file. Pass an explicit
        // empty string to create/truncate one on purpose.
        if (typeof input.content !== "string") {
          return {
            error:
              "missing content - provide the file content to write (pass an empty string to create an empty file).",
            path: path ?? "",
          };
        }
        const content = input.content;
        if (!path || !path.trim()) {
          return { error: "missing path - name the file to write.", path: "" };
        }
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
        const safety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
        );
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
          // Surface the written file in the Artifacts panel for quick access.
          useArtifactsStore.getState().add(ctx.getSessionId() ?? "", {
            kind: "file",
            title: abs.split(/[\\/]/).pop() || abs,
            payload: abs,
          });
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
        const safety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
        );
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
          const msg = String(e);
          if (msg.includes("already exists")) {
            return { path: abs, ok: true, already_exists: true };
          }
          return { error: msg, path: abs };
        }
      },
    }),
  } as const;
}
