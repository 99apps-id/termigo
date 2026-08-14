// Deciding whether a tool acts on this machine or on the remote host.
//
// The rule this module exists to enforce: when an SSH session is active, a
// tool either does the remote thing or says it cannot. It must never quietly
// do the local thing instead.
//
// That was the actual danger in the half-finished state this replaces. Reads
// were routed to SFTP while every write stayed local, so the agent could read
// `/etc/nginx/nginx.conf` from the server, edit it, and write the result to a
// path on the user's own machine - with nothing in the transcript to say the
// two halves went to different computers.
//
// Tools with no remote implementation therefore refuse while a session is
// active. Refusing is recoverable: the model reads the reason and picks
// another route. Silently acting on the wrong machine is not.

import type { RemoteFsSession } from "../tools/context";

export type FsTarget =
  | { kind: "local"; path: string }
  | { kind: "remote"; sessionId: number; path: string }
  | { kind: "error"; reason: string };

/** Windows drive paths are always local: they cannot mean anything on a POSIX host. */
export function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * Resolve a tool-supplied path against the active session.
 *
 * `localResolve` is passed in rather than imported so this stays testable
 * without the tool context, and so the local path rules stay in one place.
 */
export function routePath(
  remote: RemoteFsSession | null,
  rawPath: string,
  localResolve: (p: string) => string,
): FsTarget {
  if (!remote || isWindowsPath(rawPath)) {
    return { kind: "local", path: localResolve(rawPath) };
  }
  if (rawPath.startsWith("/")) {
    return { kind: "remote", sessionId: remote.sessionId, path: rawPath };
  }
  if (!remote.cwd) {
    return {
      kind: "error",
      reason: `cannot resolve the relative path "${rawPath}": the remote shell has not reported a working directory yet. Pass an absolute remote path.`,
    };
  }
  const base = remote.cwd.endsWith("/") ? remote.cwd : `${remote.cwd}/`;
  return { kind: "remote", sessionId: remote.sessionId, path: `${base}${rawPath}` };
}

/**
 * The refusal a local-only tool returns while a session is active.
 *
 * Named for the operation so the model is told what is unavailable and what to
 * do instead, rather than being left to guess from a bare failure.
 */
export function remoteUnsupported(
  operation: string,
  alternative: string,
): { error: string } {
  return {
    error:
      `${operation} is not available over SSH. This tool would act on the local machine, ` +
      `which is almost certainly not what you meant while a remote session is open. ${alternative}`,
  };
}

/** True when a tool call would land on the remote host. */
export function isRemoteTarget(t: FsTarget): t is Extract<FsTarget, { kind: "remote" }> {
  return t.kind === "remote";
}

/**
 * Cache key for a file, namespaced by the machine it lives on.
 *
 * The read cache powers two things: skipping a re-read that would return
 * identical bytes, and the read-before-edit invariant. Keying it on the path
 * alone lets a remote `/etc/nginx/nginx.conf` answer for a local file at the
 * same path - which on Linux and macOS is an ordinary occurrence, not a
 * contrived one. It would report `unchanged` for a file never read, and let an
 * edit satisfy read-before-edit against the wrong machine's contents.
 */
export function fileCacheKey(path: string, sessionId?: number | null): string {
  return sessionId == null ? path : `ssh:${sessionId}:${path}`;
}
