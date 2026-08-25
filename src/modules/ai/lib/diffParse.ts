import type { DiffHunk, FileDiff } from "../components/InlineDiffReview";

/**
 * Parse a unified diff (as produced by `git diff`) into per-file hunk
 * structures that `InlineDiffReview` can render.
 *
 * Only the parts the review UI needs are extracted: the target file path and,
 * for each `@@` header, the typed lines that follow. Metadata lines (index,
 * mode, rename markers) are skipped. Files without any hunk headers yield no
 * entry, so callers can fall back to showing the raw text.
 */
export function parseUnifiedDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let hunkSeq = 0;

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      currentHunk = null;
      current = null;
      // "diff --git a/<path> b/<path>" — take the b-side, which is where the
      // content lives after the change. Paths with spaces survive because the
      // split happens on the last " b/" occurrence.
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      const path = match ? match[2] : line.slice("diff --git ".length);
      current = { filePath: path, hunks: [] };
      files.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith("@@")) {
      hunkSeq++;
      currentHunk = {
        id: `${current.filePath}-h${hunkSeq}`,
        header: line,
        lines: [],
        status: "pending",
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", content: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    }
    // "\ No newline at end of file" and anything else: ignored.
  }

  return files.filter((f) => f.hunks.length > 0);
}

/**
 * Undo one hunk against the current file content.
 *
 * The forward side of a hunk is its context plus added lines; the reverse is
 * context plus deleted lines. Finds where the forward side matches in the
 * file and swaps in the reverse side. Returns null when the hunk no longer
 * applies cleanly, which happens if the file moved on since the diff was
 * taken - the caller should then refuse rather than guess.
 */
export function reverseApplyHunk(
  content: string,
  hunk: DiffHunk,
): string | null {
  const forward = hunk.lines
    .filter((l) => l.type !== "del")
    .map((l) => l.content);
  const backward = hunk.lines
    .filter((l) => l.type !== "add")
    .map((l) => l.content);
  if (forward.length === 0) return null;

  const lines = content.split("\n");
  outer: for (let i = 0; i + forward.length <= lines.length; i++) {
    for (let j = 0; j < forward.length; j++) {
      if (lines[i + j] !== forward[j]) continue outer;
    }
    return [
      ...lines.slice(0, i),
      ...backward,
      ...lines.slice(i + forward.length),
    ].join("\n");
  }
  return null;
}
