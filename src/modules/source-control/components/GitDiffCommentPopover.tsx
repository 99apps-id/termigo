"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function GitDiffCommentPopover({
  anchorLine,
  selectedText,
  onSubmit,
  onClose,
  initial,
}: {
  anchorLine: number;
  selectedText?: string;
  onSubmit: (body: string) => void;
  onClose: () => void;
  initial?: { body?: string };
}) {
  const [draft, setDraft] = useState(initial?.body ?? "");

  const submit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  }, [draft, onSubmit, onClose]);

  return (
    <div className="absolute z-50 w-80 rounded-md border border-border/60 bg-background p-2 shadow-lg">
      <div className="mb-1.5 font-mono text-[10px] text-muted-foreground">
        L+{anchorLine}
        {selectedText ? (
          <span className="ml-1 text-foreground/70">
            · &quot;{selectedText.slice(0, 32)}
            {selectedText.length > 32 ? "..." : null}&quot;
          </span>
        ) : null}
      </div>
      <Textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add a note..."
        className="h-20 resize-none text-[11px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            submit();
          }
        }}
      />
      <div className="mt-1.5 flex justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[10px]"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-[10px]"
          onClick={submit}
          disabled={!draft.trim()}
        >
          {initial?.body ? "Save" : "Add"}
        </Button>
      </div>
    </div>
  );
}
