import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { BrainIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { forgetFact, type MemoryEntry, readMemory } from "../lib/memory";
import { useChatStore } from "../store/chatStore";

/**
 * What the agent has learned about this project, from `.termigo/memory.md`,
 * with one-click removal. Everything here reaches the system prompt on every
 * run, so a wrong fact is not just noise — it steers later replies. This is
 * the place to catch that without opening the file by hand.
 */
export function AgentMemoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setEntries(await readMemory(workspaceRoot));
  }, [workspaceRoot]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const forget = async (entry: MemoryEntry) => {
    if (busy) return;
    setBusy(entry.text);
    try {
      const { removed } = await forgetFact(workspaceRoot, entry.text);
      if (removed) {
        toast(`Forgot: ${entry.text.slice(0, 60)}`);
        await reload();
      } else {
        toast("That fact is no longer in memory");
        await reload();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not forget");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[13px]">
            <HugeiconsIcon icon={BrainIcon} size={15} strokeWidth={1.75} />
            Agent memory
          </DialogTitle>
        </DialogHeader>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Facts the agent recorded in{" "}
          <code className="font-mono">.termigo/memory.md</code>. They reach the
          system prompt of every run, so a wrong entry steers later replies —
          delete it here (or edit the file) to make the agent forget.
        </p>

        {!workspaceRoot ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            Open a workspace to see its agent memory.
          </div>
        ) : entries === null ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            Nothing learned yet. The next fact the agent records appears here.
          </div>
        ) : (
          <ScrollArea className="max-h-80">
            <ul className="flex flex-col gap-1.5 pr-2">
              {entries.map((entry) => (
                <li
                  key={`${entry.date}-${entry.text}`}
                  className="group flex items-start gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5"
                >
                  <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground">
                    {entry.date}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[11px] leading-snug">
                    {entry.text}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-5 w-5 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                    title="Forget this fact"
                    disabled={busy === entry.text}
                    onClick={() => void forget(entry)}
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={12}
                      strokeWidth={2}
                    />
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}

        <div className="flex justify-end border-t border-border pt-2.5">
          <Button size="xs" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
