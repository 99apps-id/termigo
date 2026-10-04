import { fileUriToPath } from "@/modules/lsp/lib/uri";

/**
 * Applying an LSP `WorkspaceEdit` to files on disk.
 *
 * The editor's rename command only patches the document that is open in the
 * view (`codemirror-languageserver`'s `applyWorkspaceEdit`), so a cross-file
 * rename needs its own applier. Kept pure and dependency-free (beyond the URI
 * helper) so the offset math and ordering are unit-tested without a language
 * server.
 */

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspTextEdit = { range: LspRange; newText: string };

/** A `documentChanges` entry that edits a file, or a resource op to ignore. */
export type LspDocumentChange =
  | { textDocument: { uri: string }; edits: LspTextEdit[] }
  | { kind: string };

export type LspWorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: LspDocumentChange[];
};

export type FileEditPlan = { path: string; edits: LspTextEdit[] };

/** Line-start offsets, so a `{line, character}` maps to a string index. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * Maps an LSP position to a UTF-16 index. LSP counts characters in UTF-16 code
 * units, which is exactly a JavaScript string index, so no codepoint math is
 * needed. The position is clamped to its line so a stale position cannot splice
 * the wrong text.
 */
function offsetAt(
  starts: number[],
  position: LspPosition,
  length: number,
): number {
  const line = Math.max(0, Math.min(position.line, starts.length - 1));
  const lineStart = starts[line];
  const lineEnd = line + 1 < starts.length ? starts[line + 1] : length;
  const offset = lineStart + Math.max(0, position.character);
  return Math.max(lineStart, Math.min(offset, lineEnd, length));
}

/**
 * Applies text edits to `content`. Edits are sorted and applied back-to-front so
 * an earlier edit never shifts a later one's offsets. Overlapping edits (which a
 * well-behaved server does not emit) keep the later one rather than corrupting
 * the file.
 */
export function applyTextEdits(
  content: string,
  edits: readonly LspTextEdit[],
): string {
  if (edits.length === 0) return content;
  const starts = lineStartOffsets(content);
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(starts, edit.range.start, content.length),
      end: offsetAt(starts, edit.range.end, content.length),
      newText: edit.newText,
    }))
    .filter((edit) => edit.start <= edit.end)
    .sort((a, b) => b.start - a.start || b.end - a.end);

  let out = content;
  let floor = content.length + 1;
  for (const edit of resolved) {
    if (edit.end > floor) continue;
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

/** Normalises a WorkspaceEdit to one plan per file, merging both shapes. */
export function collectFileEdits(edit: LspWorkspaceEdit): FileEditPlan[] {
  const byPath = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: readonly LspTextEdit[]) => {
    const path = fileUriToPath(uri);
    if (!path || edits.length === 0) return;
    const list = byPath.get(path) ?? [];
    list.push(...edits);
    byPath.set(path, list);
  };
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) add(change.textDocument.uri, change.edits);
    }
  }
  return [...byPath.entries()].map(([path, edits]) => ({ path, edits }));
}
