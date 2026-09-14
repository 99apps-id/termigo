/**
 * Detect and parse git merge conflict markers in file text.
 *
 * Scans for standard git merge conflict markers:
 * - `<<<<<<< [oursLabel]` (start of our changes)
 * - `||||||| [baseLabel]` (optional diff3 ancestor)
 * - `=======` (separator)
 * - `>>>>>>> [theirsLabel]` (end of their changes)
 */

export interface ConflictBlock {
  startLine: number;
  separatorLine: number;
  endLine: number;
  baseLine?: number;
  oursLabel?: string;
  baseLabel?: string;
  theirsLabel?: string;
  oursLines: string[];
  baseLines?: string[];
  theirsLines: string[];
}

export interface ConflictSummary {
  startLine: number;
  separatorLine: number;
  endLine: number;
  oursLabel?: string;
  theirsLabel?: string;
  oursPreview: string;
  theirsPreview: string;
}

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";

function matchMarker(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  if (line.length === prefix.length) return "";
  if (line.charCodeAt(prefix.length) !== 32) return null;
  return line.slice(prefix.length + 1).trim();
}

function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function scanConflictLines(
  lines: readonly string[],
  firstLineNumber = 1,
): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let phase: "idle" | "ours" | "base" | "theirs" = "idle";
  let partial: {
    startLine: number;
    oursLabel?: string;
    oursLines: string[];
    baseLine?: number;
    baseLabel?: string;
    baseLines?: string[];
    separatorLine?: number;
    theirsLines?: string[];
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingCr(lines[i]);
    const ln = firstLineNumber + i;

    const oursLabel = matchMarker(line, OURS_PREFIX);
    if (oursLabel !== null) {
      partial = { startLine: ln, oursLabel: oursLabel || undefined, oursLines: [] };
      phase = "ours";
      continue;
    }

    if (phase === "idle" || partial === null) continue;

    const baseLabel = matchMarker(line, BASE_PREFIX);
    if (baseLabel !== null) {
      if (phase === "ours") {
        partial.baseLine = ln;
        partial.baseLabel = baseLabel || undefined;
        partial.baseLines = [];
        phase = "base";
        continue;
      }
      partial = null;
      phase = "idle";
      continue;
    }

    if (line === SEPARATOR) {
      if (phase === "ours" || phase === "base") {
        partial.separatorLine = ln;
        partial.theirsLines = [];
        phase = "theirs";
      } else {
        partial = null;
        phase = "idle";
      }
      continue;
    }

    const theirsLabel = matchMarker(line, THEIRS_PREFIX);
    if (theirsLabel !== null) {
      if (phase === "theirs" && partial.separatorLine !== undefined && partial.theirsLines) {
        blocks.push({
          startLine: partial.startLine,
          separatorLine: partial.separatorLine,
          endLine: ln,
          baseLine: partial.baseLine,
          oursLabel: partial.oursLabel,
          baseLabel: partial.baseLabel,
          theirsLabel: theirsLabel || undefined,
          oursLines: partial.oursLines,
          baseLines: partial.baseLines,
          theirsLines: partial.theirsLines,
        });
      }
      partial = null;
      phase = "idle";
      continue;
    }

    if (phase === "ours") partial.oursLines.push(line);
    else if (phase === "base" && partial.baseLines) partial.baseLines.push(line);
    else if (phase === "theirs" && partial.theirsLines) partial.theirsLines.push(line);
  }

  return blocks;
}

export function scanTextForConflicts(
  text: string,
  firstLineNumber = 1,
): ConflictBlock[] {
  if (!text.includes(OURS_PREFIX)) return [];
  const lines = text.split("\n");
  return scanConflictLines(lines, firstLineNumber);
}

export function summarizeConflicts(
  blocks: readonly ConflictBlock[],
  maxPreviewLines = 5,
): ConflictSummary[] {
  return blocks.map((b) => ({
    startLine: b.startLine,
    separatorLine: b.separatorLine,
    endLine: b.endLine,
    oursLabel: b.oursLabel,
    theirsLabel: b.theirsLabel,
    oursPreview: b.oursLines.slice(0, maxPreviewLines).join("\n"),
    theirsPreview: b.theirsLines.slice(0, maxPreviewLines).join("\n"),
  }));
}
