// Moving, copying and deleting files.
//
// The Rust commands for all three were already registered and already used by
// the file explorer; only the agent had no way to reach them. So the agent
// could not move a file the user can drag with the mouse in the panel beside
// it.
//
// Every path goes through the same write check as write_file. That check is
// what confines these to the workspace and keeps them off .env, keys and the
// rest of the deny-list, and it runs inside execute - after approval - so no
// approval mode can authorise something the safety layer refuses.

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";

import { sftpDelete, sftpRename } from "@/modules/ssh/sftp";
import { routePath, remoteUnsupported } from "../lib/remoteFs";
import { checkWritableCanonical } from "../lib/security";
import { checkWritable } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

/** Last path segment, for reporting where a copy actually landed. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function buildFileOpsTools(ctx: ToolContext) {
  return {
    move_file: tool({
      description:
        "Move or rename a file or directory. Refuses to overwrite an existing destination — delete it first if that is really what you want. Both paths must be inside the workspace. Asks for approval.",
      inputSchema: z.object({
        from: z
          .string()
          .describe("Existing path, absolute or relative to the terminal cwd."),
        to: z
          .string()
          .describe("New path, absolute or relative to the terminal cwd."),
      }),
      needsApproval: true,
      execute: async ({ from, to }) => {
        const remote = ctx.getRemoteSession();
        const fromT = routePath(remote, from, (p) => resolvePath(p, ctx.getCwd()));
        const toT = routePath(remote, to, (p) => resolvePath(p, ctx.getCwd()));
        if (fromT.kind === "error") return { error: fromT.reason, path: from };
        if (toT.kind === "error") return { error: toT.reason, path: to };
        // Both ends must sit on the same machine. A move that crossed hosts
        // would be a download-then-upload wearing a rename's name.
        if (fromT.kind !== toT.kind) {
          return {
            error:
              "cannot move between the local machine and the remote host; both paths must be on the same one",
            from,
            to,
          };
        }
        if (fromT.kind === "remote" && toT.kind === "remote") {
          for (const p of [fromT.path, toT.path]) {
            const check = checkWritable(p);
            if (!check.ok) return { error: check.reason, path: p };
          }
          try {
            await sftpRename(fromT.sessionId, fromT.path, toT.path);
            return { moved: true, remote: true, from: fromT.path, to: toT.path };
          } catch (e) {
            return { error: String(e), from: fromT.path, to: toT.path, remote: true };
          }
        }

        const fromPath = fromT.path;
        const toPath = toT.path;
        // Both ends are checked: reading the check as "is the source allowed"
        // alone would let a move drop a file somewhere it may not go, and
        // checking only the destination would let one be taken from anywhere.
        const src = await checkWritableCanonical(fromPath, native.canonicalize);
        if (!src.ok) return { error: src.reason, path: fromPath };
        const dest = await checkWritableCanonical(toPath, native.canonicalize);
        if (!dest.ok) return { error: dest.reason, path: toPath };

        try {
          await native.rename(src.canonical, toPath);
          return { moved: true, from: src.canonical, to: toPath };
        } catch (e) {
          return { error: String(e), from: src.canonical, to: toPath };
        }
      },
    }),

    copy_file: tool({
      description:
        "Copy a file or directory into a destination directory, keeping its name. Directories are copied recursively. Refuses to overwrite. Both paths must be inside the workspace. Asks for approval.",
      inputSchema: z.object({
        source: z
          .string()
          .describe("File or directory to copy, absolute or relative to the terminal cwd."),
        dest_dir: z
          .string()
          .describe("Existing directory to copy INTO. The name is preserved."),
      }),
      needsApproval: true,
      execute: async ({ source, dest_dir }) => {
        // SFTP here has no server-side copy, and doing it by hand would mean
        // downloading and re-uploading every byte - silently, and wrongly for
        // directories. Refusing says so instead of pretending.
        if (ctx.getRemoteSession()) {
          return remoteUnsupported(
            "copy_file",
            "Use suggest_command to run `cp -r src dest` at the remote prompt, or read_file then write_file for a single small file.",
          );
        }
        const sourcePath = resolvePath(source, ctx.getCwd());
        const destPath = resolvePath(dest_dir, ctx.getCwd());
        const src = await checkWritableCanonical(sourcePath, native.canonicalize);
        if (!src.ok) return { error: src.reason, path: sourcePath };
        const dest = await checkWritableCanonical(destPath, native.canonicalize);
        if (!dest.ok) return { error: dest.reason, path: destPath };

        try {
          await native.copyInto([src.canonical], dest.canonical);
          // Report the landing path: the tool takes a directory, so the model
          // would otherwise have to guess where the copy ended up.
          return {
            copied: true,
            from: src.canonical,
            to: joinPath(dest.canonical, basename(src.canonical)),
          };
        } catch (e) {
          return { error: String(e), from: src.canonical, to: dest.canonical };
        }
      },
    }),

    delete_file: tool({
      description:
        "Delete a file or directory (directories are removed recursively). This is not recoverable unless the path is tracked by git — prefer move_file to set something aside when you are unsure. Must be inside the workspace. Always asks for approval, including under Auto-approve edits.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Path to delete, absolute or relative to the terminal cwd."),
      }),
      needsApproval: true,
      execute: async ({ path }) => {
        const target = routePath(ctx.getRemoteSession(), path, (p) =>
          resolvePath(p, ctx.getCwd()),
        );
        if (target.kind === "error") return { error: target.reason, path };
        if (target.kind === "remote") {
          const check = checkWritable(target.path);
          if (!check.ok) return { error: check.reason, path: target.path };
          try {
            await sftpDelete(target.sessionId, target.path);
            return { deleted: true, remote: true, path: target.path };
          } catch (e) {
            return { error: String(e), path: target.path, remote: true };
          }
        }

        const reqPath = target.path;
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        try {
          await native.deletePath(safety.canonical);
          return { deleted: true, path: safety.canonical };
        } catch (e) {
          return { error: String(e), path: safety.canonical };
        }
      },
    }),
  };
}
