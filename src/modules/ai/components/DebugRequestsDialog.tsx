import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useDebugStore, type DebugCapture } from "../store/debugStore";

/**
 * Reads the requests Termigo assembled for the provider.
 *
 * A provider rejection names a symptom and the transcript shows the reply, but
 * neither shows the system prompt, the compacted history, or which tools were
 * attached on that step - so diagnosing an agent problem meant inferring the
 * request from its consequences. This shows the request itself.
 *
 * Lives in the main window on purpose: captures are in-memory, and the
 * settings window is a separate webview that cannot see them.
 */
export function DebugRequestsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const captures = useDebugStore((s) => s.captures);
  const clear = useDebugStore((s) => s.clear);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected =
    captures.find((c) => c.id === selectedId) ?? captures[0] ?? null;

  const json = useMemo(
    () => (selected ? JSON.stringify(selected, null, 2) : ""),
    [selected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            Requests sent to the provider
          </DialogTitle>
        </DialogHeader>

        {captures.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            Nothing captured yet. Capturing is on, so the next message the agent
            sends will appear here — one entry per step.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <ul className="w-52 shrink-0 space-y-1 overflow-y-auto pr-1">
              {captures.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "w-full rounded-md border px-2 py-1.5 text-left text-[10px] leading-tight transition-colors",
                      selected?.id === c.id
                        ? "border-border bg-accent text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    <div className="font-medium">{summarize(c)}</div>
                    <div className="mt-0.5 opacity-70">
                      {new Date(c.at).toLocaleTimeString()} · {c.model.id}
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card/60 p-2.5 text-[10px] leading-relaxed">
              {json}
            </pre>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
          <span className="text-[10px] text-muted-foreground">
            {captures.length > 0
              ? `${captures.length} captured · newest first · kept in memory only`
              : "Kept in memory only, never written to disk"}
          </span>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={!selected}
              onClick={() => void navigator.clipboard?.writeText(json)}
            >
              Copy JSON
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={captures.length === 0}
              onClick={() => {
                clear();
                setSelectedId(null);
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One line that says what this step was, without opening it. */
function summarize(c: DebugCapture): string {
  const messages = Array.isArray(c.messages) ? c.messages.length : 0;
  const budget = c.params.stepBudget;
  return `${messages} msg · ${c.tools.length} tools${
    typeof budget === "number" ? ` · ${budget} steps` : ""
  }`;
}
