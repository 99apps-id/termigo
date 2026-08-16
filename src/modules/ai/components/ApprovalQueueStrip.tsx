import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useApprovalQueue } from "../store/approvalQueueStore";

/**
 * What sub-agents are waiting on, and which number answers which.
 *
 * The main agent's approval card can sit inline in the transcript because
 * there is only ever one and the run is stopped behind it. Sub-agents ask
 * concurrently while the transcript is still moving, so their requests need a
 * fixed place, and each row shows the number `/approve n` addresses - the
 * command is unusable if you cannot see what you are numbering.
 */
export function ApprovalQueueStrip() {
  const pending = useApprovalQueue((s) => s.pending);
  const respond = useApprovalQueue((s) => s.respond);

  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col min-h-0 shrink-0 border-t-2 border-amber-500/40 bg-amber-500/5 px-3 py-1.5 max-h-[35%]">
      <div className="my-1.5 flex items-center gap-2 shrink-0">
        <span className="text-[11px] font-medium text-foreground">
          Waiting for you
        </span>
        <span className="text-[11px] tabular-nums font-mono text-muted-foreground">
          {pending.length}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground">
          /approve n · all
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => respond(pending.map((p) => p.id), false)}
        >
          Deny all
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-1 pb-1">
          {pending.map((p, i) => (
            <div
              key={p.id}
              className="flex items-center gap-2 rounded border border-border/50 bg-background/60 px-2 py-1"
            >
              <span className="w-4 shrink-0 text-[11px] tabular-nums font-mono text-muted-foreground">
                {i + 1}
              </span>
              <span className="shrink-0 text-[11px] font-medium text-foreground">
                {p.requester}
              </span>
              <span className="shrink-0 text-[11px] font-mono text-muted-foreground">
                {p.toolName}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {p.summary}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                aria-label={`Deny ${i + 1}`}
                onClick={() => respond([p.id], false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              </Button>
              <Button
                size="sm"
                variant="default"
                className="h-6 w-6 p-0"
                aria-label={`Approve ${i + 1}`}
                onClick={() => respond([p.id], true)}
              >
                <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
