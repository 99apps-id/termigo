/**
 * Unified-diff parsing and application.
 *
 * A string-replace edit drifts when a formatter reflows whitespace or the model
 * mis-copies context, which is the failure mode `apply_patch` exists to avoid:
 * the patch carries its own context, so it applies exactly where it was written
 * or fails loudly. Kept pure (no Tauri, no node built-ins) so the parser and the
 * line math are unit-tested directly; the tool layer does the file IO.
 */

export type DiffLineType = "context" | "add" | "remove";
export type DiffLine = { type: DiffLineType; text: string };

export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

export type FilePatch = {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
};

export type ParseResult = { files: FilePatch[]; error?: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip the `a/`/`b/` prefix and any trailing tab-separated metadata. */
function cleanPath(raw: string): string {
  let path = raw.split("\t")[0].trim();
  // A space before a timestamp is common too.
  const space = path.indexOf(" ");
  if (space > 0) path = path.slice(0, space);
  if (path === "/dev/null") return "/dev/null";
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}

export function parseUnifiedDiff(text: string): ParseResult {
  const files: FilePatch[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("--- ")) {
      i += 1;
      continue;
    }
    const oldPath = cleanPath(line.slice(4));
    const next = lines[i + 1];
    if (next === undefined || !next.startsWith("+++ ")) {
      return {
        files,
        error: `malformed patch: "---" for ${oldPath} is not followed by "+++"`,
      };
    }
    const newPath = cleanPath(next.slice(4));
    i += 2;

    const hunks: DiffHunk[] = [];
    while (i < lines.length && lines[i].startsWith("@@")) {
      const header = HUNK_HEADER.exec(lines[i]);
      if (!header) {
        return { files, error: `malformed hunk header: ${lines[i]}` };
      }
      const hunk: DiffHunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      i += 1;
      // Bounded by the header's own counts rather than by looking for the next
      // header: a removed line whose content begins with "-- " renders as
      // "--- " and would otherwise be mistaken for a file header. The header
      // checks remain as a guard against a miscounted patch.
      let oldSeen = 0;
      let newSeen = 0;
      while (
        i < lines.length &&
        (oldSeen < hunk.oldCount || newSeen < hunk.newCount)
      ) {
        const body = lines[i];
        if (body.startsWith("@@")) break;
        if (body.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
          break;
        }
        if (body.startsWith("\\")) {
          // "\ No newline at end of file" is metadata for the line before it.
          i += 1;
          continue;
        }
        const marker = body[0];
        if (marker === " ") {
          hunk.lines.push({ type: "context", text: body.slice(1) });
          oldSeen += 1;
          newSeen += 1;
        } else if (marker === "+") {
          hunk.lines.push({ type: "add", text: body.slice(1) });
          newSeen += 1;
        } else if (marker === "-") {
          hunk.lines.push({ type: "remove", text: body.slice(1) });
          oldSeen += 1;
        } else {
          break;
        }
        i += 1;
      }
      hunks.push(hunk);
    }

    if (hunks.length === 0) {
      return { files, error: `patch for ${newPath} has no hunks` };
    }
    files.push({ oldPath, newPath, hunks });
  }

  if (files.length === 0) {
    return { files, error: "no file headers found (expected '--- a/path')" };
  }
  return { files };
}

function matchAt(
  lines: readonly string[],
  start: number,
  expected: readonly string[],
  normalize: boolean,
): boolean {
  if (start < 0 || start + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const a = normalize ? lines[start + i].replace(/\s+$/, "") : lines[start + i];
    const b = normalize ? expected[i].replace(/\s+$/, "") : expected[i];
    if (a !== b) return false;
  }
  return true;
}

/** Locate `expected` near `preferred`, widening outward, then ignoring trailing space. */
function findBlock(
  lines: readonly string[],
  expected: readonly string[],
  preferred: number,
): number {
  if (expected.length === 0) {
    return Math.max(0, Math.min(preferred, lines.length));
  }
  const last = lines.length - expected.length;
  for (const normalize of [false, true]) {
    for (let d = 0; d <= lines.length; d += 1) {
      const back = preferred - d;
      if (back >= 0 && matchAt(lines, back, expected, normalize)) return back;
      const forward = preferred + d;
      if (forward <= last && matchAt(lines, forward, expected, normalize)) {
        return forward;
      }
    }
  }
  return -1;
}

export type ApplyResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** Apply every hunk of one file patch to `content`. */
export function applyFilePatch(
  content: string,
  patch: FilePatch,
): ApplyResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lf = content.replace(/\r\n/g, "\n");
  const lines = lf.split("\n");
  let offset = 0;

  for (const hunk of patch.hunks) {
    const oldLines = hunk.lines
      .filter((l) => l.type !== "add")
      .map((l) => l.text);
    // A pure insertion (`@@ -N,0 ...`) lands AFTER old line N, so its 0-based
    // index is N; a replacement starts AT old line N (index N-1).
    const base = oldLines.length === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const preferred = Math.max(0, base + offset);
    const at = findBlock(lines, oldLines, preferred);
    if (at === -1) {
      const preview = oldLines.slice(0, 2).join(" / ") || "(no old lines)";
      return {
        ok: false,
        error: `hunk at line ${hunk.oldStart} did not match the file (context: ${preview})`,
      };
    }
    // Rebuild from the hunk, keeping the ORIGINAL text of context lines (so a
    // loose whitespace match does not silently reflow untouched lines) and the
    // patch text only for added lines.
    const replacement: string[] = [];
    let cursor = at;
    for (const line of hunk.lines) {
      if (line.type === "context") {
        replacement.push(lines[cursor] ?? line.text);
        cursor += 1;
      } else if (line.type === "remove") {
        cursor += 1;
      } else {
        replacement.push(line.text);
      }
    }
    lines.splice(at, oldLines.length, ...replacement);
    offset += replacement.length - oldLines.length;
  }

  const joined = lines.join("\n");
  const restored = eol === "\n" ? joined : joined.replace(/\n/g, "\r\n");
  return { ok: true, content: restored };
}
