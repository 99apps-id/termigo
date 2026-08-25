import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type DiffHunk = {
  id: string;
  header: string;
  lines: Array<{
    type: "add" | "del" | "context";
    content: string;
  }>;
  status: "pending" | "accepted" | "rejected";
};

export type FileDiff = {
  filePath: string;
  hunks: DiffHunk[];
};

export function InlineDiffReview({
  fileDiff,
  onApplyHunk,
  onRejectHunk,
  onApplyAll,
  onDiscardAll,
  className,
}: {
  fileDiff: FileDiff;
  onApplyHunk?: (hunkId: string) => void;
  onRejectHunk?: (hunkId: string) => void;
  onApplyAll?: () => void;
  onDiscardAll?: () => void;
  className?: string;
}) {
  const [hunks, setHunks] = useState(fileDiff.hunks);

  const handleAction = (hunkId: string, action: "accepted" | "rejected") => {
    setHunks((prev) =>
      prev.map((h) => (h.id === hunkId ? { ...h, status: action } : h)),
    );
    if (action === "accepted") onApplyHunk?.(hunkId);
    if (action === "rejected") onRejectHunk?.(hunkId);
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-card overflow-hidden text-xs font-mono my-2",
        className,
      )}
    >
      <div className="flex items-center justify-between bg-muted/50 px-3 py-2 border-b border-border/50">
        <span className="font-semibold text-foreground truncate">{fileDiff.filePath}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px] px-2 text-emerald-600 hover:text-emerald-700"
            onClick={onApplyAll}
          >
            Apply All
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[11px] px-2 text-destructive hover:text-destructive/90"
            onClick={onDiscardAll}
          >
            Discard
          </Button>
        </div>
      </div>

      <div className="divide-y divide-border/30">
        {hunks.map((hunk) => (
          <div key={hunk.id} className="p-2 space-y-1.5">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground bg-muted/20 px-2 py-0.5 rounded">
              <span>{hunk.header}</span>
              <div className="flex items-center gap-1">
                {hunk.status === "pending" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleAction(hunk.id, "accepted")}
                      className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAction(hunk.id, "rejected")}
                      className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20"
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded uppercase text-[9px]",
                      hunk.status === "accepted"
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {hunk.status}
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-0.5 text-[11px] overflow-x-auto leading-relaxed">
              {hunk.lines.map((line, idx) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: line items are static
                  key={idx}
                  className={cn(
                    "px-2 py-0.5 rounded-sm flex items-start gap-2",
                    line.type === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    line.type === "del" && "bg-destructive/10 text-destructive",
                    line.type === "context" && "text-muted-foreground",
                  )}
                >
                  <span className="select-none text-muted-foreground/60 w-3 text-right">
                    {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                  </span>
                  <span className="whitespace-pre">{line.content}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
