import { Shimmer } from "@/components/ai-elements/shimmer";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { artifactOpener } from "@/modules/ai/lib/artifactOpen";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Edit02Icon,
  FileEditIcon,
  FilePlusIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { memo, useCallback, useMemo, useState } from "react";

export type AnyToolPart = ToolUIPart | DynamicToolUIPart;

export type DiffLine = {
  type: "context" | "add" | "del";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type DiffResult = {
  lines: DiffLine[];
  additions: number;
  deletions: number;
};

/**
 * Line-level diff with common prefix and suffix preservation, LCS for
 * the modified chunk, and up to 2 lines of surrounding context.
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffResult {
  const a = oldStr ? oldStr.split("\n") : [];
  const b = newStr ? newStr.split("\n") : [];

  if (a.length === 0 && b.length === 0) {
    return { lines: [], additions: 0, deletions: 0 };
  }

  if (a.length === 0) {
    const lines: DiffLine[] = b.map((text, i) => ({
      type: "add",
      text,
      newLineNumber: i + 1,
    }));
    return { lines, additions: lines.length, deletions: 0 };
  }

  if (b.length === 0) {
    const lines: DiffLine[] = a.map((text, i) => ({
      type: "del",
      text,
      oldLineNumber: i + 1,
    }));
    return { lines, additions: 0, deletions: lines.length };
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  const contextPrefixStart = Math.max(0, prefix - 2);
  for (let i = contextPrefixStart; i < prefix; i++) {
    lines.push({
      type: "context",
      text: a[i],
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    });
  }

  if (midA.length * midB.length <= 250_000) {
    const dp: number[][] = Array.from({ length: midA.length + 1 }, () =>
      new Array(midB.length + 1).fill(0),
    );
    for (let i = 0; i < midA.length; i++) {
      for (let j = 0; j < midB.length; j++) {
        if (midA[i] === midB[j]) {
          dp[i + 1][j + 1] = dp[i][j] + 1;
        } else {
          dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = midA.length;
    let j = midB.length;
    const midDiff: DiffLine[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && midA[i - 1] === midB[j - 1]) {
        midDiff.unshift({
          type: "context",
          text: midA[i - 1],
          oldLineNumber: prefix + i,
          newLineNumber: prefix + j,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        midDiff.unshift({
          type: "add",
          text: midB[j - 1],
          newLineNumber: prefix + j,
        });
        additions++;
        j--;
      } else if (i > 0) {
        midDiff.unshift({
          type: "del",
          text: midA[i - 1],
          oldLineNumber: prefix + i,
        });
        deletions++;
        i--;
      }
    }
    lines.push(...midDiff);
  } else {
    for (let i = 0; i < midA.length; i++) {
      lines.push({
        type: "del",
        text: midA[i],
        oldLineNumber: prefix + i + 1,
      });
      deletions++;
    }
    for (let j = 0; j < midB.length; j++) {
      lines.push({
        type: "add",
        text: midB[j],
        newLineNumber: prefix + j + 1,
      });
      additions++;
    }
  }

  const contextSuffixCount = Math.min(2, suffix);
  for (let k = 0; k < contextSuffixCount; k++) {
    const idxA = a.length - suffix + k;
    const idxB = b.length - suffix + k;
    lines.push({
      type: "context",
      text: a[idxA],
      oldLineNumber: idxA + 1,
      newLineNumber: idxB + 1,
    });
  }

  return { lines, additions, deletions };
}

export function extractPathFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const keys = [
    "path",
    "file_path",
    "filepath",
    "file",
    "filename",
    "target",
    "target_path",
  ];
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

function splitPath(fullPath: string): { dir: string; base: string } {
  const norm = fullPath.replace(/\\/g, "/");
  const slashIdx = norm.lastIndexOf("/");
  if (slashIdx < 0) {
    return { dir: "", base: norm };
  }
  return {
    dir: norm.slice(0, slashIdx + 1),
    base: norm.slice(slashIdx + 1),
  };
}

const MAX_DIFF_LINES = 120;

export const ToolDiffCard = memo(function ToolDiffCard({
  toolName,
  part,
  className,
}: {
  toolName: string;
  part: AnyToolPart;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const [showAllLines, setShowAllLines] = useState(false);
  const [copied, setCopied] = useState(false);

  const input = part.input;
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;

  const outputObj =
    output && typeof output === "object"
      ? (output as Record<string, unknown>)
      : null;
  const outputError =
    typeof outputObj?.error === "string" ? outputObj.error : null;
  const errorMessage = errorText || outputError;

  const filePath =
    extractPathFromInput(input) ||
    (typeof outputObj?.path === "string" ? outputObj.path : null);

  const { dir, base } = filePath
    ? splitPath(filePath)
    : { dir: "", base: "unknown file" };

  const isWriting = toolName === "write_file";
  const inProgress =
    part.state === "input-streaming" || part.state === "input-available";
  const isFailed = part.state === "output-error" || Boolean(errorMessage);

  const diffData = useMemo<DiffResult>(() => {
    if (!input || typeof input !== "object") {
      return { lines: [], additions: 0, deletions: 0 };
    }
    const inp = input as Record<string, unknown>;

    if (isWriting) {
      const content = typeof inp.content === "string" ? inp.content : "";
      return computeLineDiff("", content);
    }

    if (toolName === "edit") {
      const oldStr = typeof inp.old_string === "string" ? inp.old_string : "";
      const newStr = typeof inp.new_string === "string" ? inp.new_string : "";
      return computeLineDiff(oldStr, newStr);
    }

    if (toolName === "multi_edit" && Array.isArray(inp.edits)) {
      const allLines: DiffLine[] = [];
      let totalAdd = 0;
      let totalDel = 0;
      for (const edit of inp.edits) {
        if (!edit || typeof edit !== "object") continue;
        const e = edit as Record<string, unknown>;
        const oldStr = typeof e.old_string === "string" ? e.old_string : "";
        const newStr = typeof e.new_string === "string" ? e.new_string : "";
        const d = computeLineDiff(oldStr, newStr);
        allLines.push(...d.lines);
        totalAdd += d.additions;
        totalDel += d.deletions;
      }
      return { lines: allLines, additions: totalAdd, deletions: totalDel };
    }

    return { lines: [], additions: 0, deletions: 0 };
  }, [input, isWriting, toolName]);

  const displayedLines = showAllLines
    ? diffData.lines
    : diffData.lines.slice(0, MAX_DIFF_LINES);
  const hiddenCount = diffData.lines.length - displayedLines.length;

  const handleCopyCode = useCallback(() => {
    if (diffData.lines.length === 0) return;
    const code = diffData.lines
      .filter((l) => l.type !== "del")
      .map((l) => l.text)
      .join("\n");
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [diffData.lines]);

  const handleOpenFile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!filePath) return;
      const opener = artifactOpener();
      if (opener) {
        opener.openFile(filePath);
      }
    },
    [filePath],
  );

  const actionVerb = inProgress
    ? isWriting
      ? "Writing"
      : "Editing"
    : isFailed
      ? isWriting
        ? "Failed writing"
        : "Failed editing"
      : isWriting
        ? "Wrote"
        : "Edited";

  return (
    <div
      className={cn(
        "my-1.5 overflow-hidden rounded-md border border-border/80 bg-card text-[12px] shadow-xs transition-all dark:bg-muted/20 dark:border-border/60",
        inProgress && "border-primary/50 bg-primary/5 shadow-xs dark:bg-muted/30",
        isFailed && "border-destructive/50 bg-destructive/5",
        className,
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((prev) => !prev);
          }
        }}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left select-none hover:bg-muted/50"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex size-4 shrink-0 items-center justify-center">
            {inProgress ? (
              <Spinner className="size-3 text-primary" />
            ) : isFailed ? (
              <HugeiconsIcon
                icon={Cancel01Icon}
                size={13}
                strokeWidth={2}
                className="text-destructive"
              />
            ) : (
              <HugeiconsIcon
                icon={isWriting ? FilePlusIcon : FileEditIcon}
                size={13}
                strokeWidth={1.8}
                className="text-muted-foreground"
              />
            )}
          </div>

          <span className="shrink-0 font-medium text-foreground">
            {inProgress ? (
              <Shimmer as="span" duration={1} iterations="infinite">
                {actionVerb}
              </Shimmer>
            ) : (
              actionVerb
            )}
          </span>

          <div className="flex min-w-0 items-center gap-1 font-mono text-[11px] truncate">
            {dir && (
              <span className="shrink-0 text-muted-foreground truncate">
                {dir}
              </span>
            )}
            <span className="font-semibold text-foreground truncate">
              {base}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {diffData.additions > 0 && (
            <span className="inline-flex items-center rounded border border-emerald-500/20 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:border-transparent dark:bg-emerald-500/20 dark:text-emerald-300">
              +{diffData.additions}
            </span>
          )}
          {diffData.deletions > 0 && (
            <span className="inline-flex items-center rounded border border-destructive/20 bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-destructive dark:border-transparent dark:bg-destructive/20 dark:text-red-300">
              -{diffData.deletions}
            </span>
          )}

          {filePath && (
            <button
              type="button"
              title="Open file in editor"
              onClick={handleOpenFile}
              className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/70 px-1.5 py-0.5 text-[10.5px] font-medium text-foreground hover:bg-muted focus-visible:outline-none"
            >
              <HugeiconsIcon
                icon={Edit02Icon}
                size={11}
                strokeWidth={1.8}
                className="text-muted-foreground"
              />
              <span>Open</span>
            </button>
          )}

          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2}
            className={cn(
              "text-muted-foreground transition-transform duration-150",
              open ? "rotate-90" : "rotate-0",
            )}
          />
        </div>
      </div>

      {open && (
        <div className="border-t border-border/40">
          {errorMessage && (
            <div className="border-b border-destructive/20 bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap">
              {errorMessage}
            </div>
          )}

          {diffData.lines.length > 0 ? (
            <div className="relative">
              <div className="flex items-center justify-between border-b border-border/30 bg-muted/30 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
                <span className="truncate">{filePath || base}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    title="Copy code"
                    onClick={handleCopyCode}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
                  >
                    <HugeiconsIcon
                      icon={copied ? Tick01Icon : Copy01Icon}
                      size={10.5}
                      strokeWidth={1.8}
                    />
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>

              <div className="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed select-text">
                {displayedLines.map((line, idx) => {
                  const isAdd = line.type === "add";
                  const isDel = line.type === "del";
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional
                      key={idx}
                      className={cn(
                        "flex items-baseline whitespace-pre px-2 hover:bg-muted/40",
                        isAdd &&
                          "bg-emerald-500/15 text-emerald-950 font-medium dark:bg-emerald-500/20 dark:text-emerald-200",
                        isDel &&
                          "bg-destructive/15 text-red-950 font-medium dark:bg-destructive/20 dark:text-red-200",
                        !isAdd && !isDel && "text-foreground",
                      )}
                    >
                      <span className="w-4 shrink-0 select-none text-center font-bold opacity-80">
                        {isAdd ? "+" : isDel ? "-" : " "}
                      </span>

                      <span className="w-8 shrink-0 select-none text-right font-mono text-[10px] text-muted-foreground opacity-75 pr-2">
                        {line.newLineNumber ?? line.oldLineNumber ?? ""}
                      </span>

                      <span className="min-w-0 flex-1 overflow-x-auto">
                        {line.text || " "}
                      </span>
                    </div>
                  );
                })}

                {hiddenCount > 0 && (
                  <div className="flex items-center justify-between bg-muted/40 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
                    <span>{hiddenCount} more changed lines</span>
                    <button
                      type="button"
                      onClick={() => setShowAllLines(true)}
                      className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                    >
                      Show all
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : !errorMessage ? (
            <div className="px-3 py-2 text-[11px] italic text-muted-foreground">
              {inProgress
                ? "Preparing diff..."
                : "No line-level changes detected."}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});
