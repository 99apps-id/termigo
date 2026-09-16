import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GitDiffComment } from "../store/diffCommentStore";

function lineLabel(comment: GitDiffComment) {
  if (comment.side === "old") return `L-${comment.lineNumber}`;
  return `L+${comment.lineNumber}`;
}

export function GitDiffCommentCard({
  comment,
  onEdit,
  onDelete,
}: {
  comment: GitDiffComment;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 text-[11px]"
      data-comment-id={comment.id}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {lineLabel(comment)}
          {comment.selectedText
            ? ` · "${comment.selectedText.slice(0, 40)}"`
            : null}
        </span>
        <div className="flex gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={onEdit}
            aria-label="Edit comment"
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={onDelete}
            aria-label="Delete comment"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      <div className="whitespace-pre-wrap break-words text-foreground/90">
        {comment.body}
      </div>
    </div>
  );
}
