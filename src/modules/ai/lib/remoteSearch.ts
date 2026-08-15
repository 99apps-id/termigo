// Searching the remote host.
//
// Built on the server's own `grep` and `find` rather than walking the tree over
// SFTP. A recursive SFTP walk means one round trip per directory and one file
// download per candidate; on a real project tree that is thousands of round
// trips over a single channel, for a search the remote box does locally in
// milliseconds.
//
// The cost is that a command string is assembled and handed to a remote shell,
// so every interpolated value is single-quoted here. Nothing in this module
// trusts its input: the pattern comes from the model, and the paths can come
// from a file the model read.

/** Lines returned to the agent before the result is cut. */
export const REMOTE_SEARCH_MAX_RESULTS = 200;

/**
 * Quote a value for POSIX `sh`.
 *
 * Single quotes disable every form of expansion, so the only character needing
 * care is the single quote itself: close the string, emit an escaped quote,
 * reopen. Anything less and a pattern containing `;` or a backtick becomes a
 * second command running as the SSH user.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the grep command.
 *
 * `-I` skips binaries, `-n` numbers lines, `-r` recurses, `-E` selects the same
 * extended-regex dialect the local search uses so a pattern behaves the same on
 * both sides. `--` stops option parsing, so a pattern or path starting with `-`
 * cannot become a flag.
 */
export function buildGrepCommand(opts: {
  pattern: string;
  path: string;
  glob?: readonly string[];
  caseInsensitive?: boolean;
  maxResults?: number;
}): string {
  const max = opts.maxResults ?? REMOTE_SEARCH_MAX_RESULTS;
  const includes = (opts.glob ?? []).map(
    // grep matches --include against the basename, so a leading `**/` from a
    // caller thinking in globs would match nothing at all.
    (g) => `--include=${shellQuote(g.replace(/^\*\*\//, ""))}`,
  );
  const flags = ["-r", "-n", "-I", "-E", ...(opts.caseInsensitive ? ["-i"] : [])];
  return [
    "grep",
    ...flags,
    ...includes,
    "--",
    shellQuote(opts.pattern),
    shellQuote(opts.path),
    // head closes the pipe once it has enough, so grep stops early on a big
    // tree instead of scanning it all and throwing the rest away.
    `2>/dev/null | head -n ${Math.max(1, Math.floor(max))}`,
  ].join(" ");
}

/** Build the glob command. `-name` matches the basename, as callers expect. */
export function buildFindCommand(opts: {
  pattern: string;
  path: string;
  maxResults?: number;
}): string {
  const max = opts.maxResults ?? REMOTE_SEARCH_MAX_RESULTS;
  const name = opts.pattern.replace(/^\*\*\//, "");
  return [
    "find",
    shellQuote(opts.path),
    "-type",
    "f",
    "-name",
    shellQuote(name),
    `2>/dev/null | head -n ${Math.max(1, Math.floor(max))}`,
  ].join(" ");
}

export type RemoteGrepHit = { path: string; line: number; text: string };

/**
 * Parse `grep -rn` output.
 *
 * The format is `path:line:text`, and only the first two colons are separators
 * - the matched text routinely contains more. Splitting on all of them would
 * corrupt every match in a URL or a timestamp.
 */
export function parseGrepOutput(stdout: string): RemoteGrepHit[] {
  const out: RemoteGrepHit[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const first = raw.indexOf(":");
    if (first <= 0) continue;
    const second = raw.indexOf(":", first + 1);
    if (second <= first) continue;
    const line = Number(raw.slice(first + 1, second));
    if (!Number.isFinite(line)) continue;
    out.push({
      path: raw.slice(0, first),
      line,
      text: raw.slice(second + 1),
    });
  }
  return out;
}

/** Parse `find` output: one path per line. */
export function parseFindOutput(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l.length > 0);
}

/**
 * Whether an exit code means "no matches" rather than a failure.
 *
 * grep exits 1 when it found nothing, which is not an error and must not be
 * reported as one. Piping through `head` means the shell reports head's status,
 * so 0 with empty output means the same thing.
 */
export function isNoMatches(exitCode: number | null, stdout: string): boolean {
  return stdout.length === 0 && (exitCode === 0 || exitCode === 1);
}

/**
 * Resolve the directory a remote search should start from.
 *
 * A relative root cannot be used verbatim: the exec channel starts in the SSH
 * user's home, not wherever the interactive shell has been `cd`-ed to, so
 * `src` would search the wrong tree without ever failing.
 */
export function resolveRemoteRoot(
  root: string | undefined,
  cwd: string | null,
): { ok: true; path: string } | { ok: false; error: string } {
  const raw = root?.trim();
  if (raw && raw.startsWith("/")) return { ok: true, path: raw };
  if (!cwd) {
    return {
      ok: false,
      error:
        "no remote directory to search: the remote shell has not reported a working directory yet, so pass `root` as an absolute remote path",
    };
  }
  if (!raw || raw === ".") return { ok: true, path: cwd };
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return { ok: true, path: `${base}${raw}` };
}
