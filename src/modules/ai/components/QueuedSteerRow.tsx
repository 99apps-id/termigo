import { Cancel01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useComposer } from "../lib/composer";

/**
 * Messages typed while the agent is working, shown above the input.
 *
 * Steering is only trustworthy if it is visible. Silently holding text would be
 * no better than the old behaviour of silently dropping it: either way the user
 * cannot tell whether the app took what they typed. Each row says what is
 * waiting and offers a way to take it back before it sends.
 */
export function QueuedSteerRow() {
  const { queued, cancelQueued } = useComposer();
  if (queued.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {queued.map((m, i) => (
        <div
          // Index is the identity here: the queue is an ordered buffer with no
          // stable ids, and cancel addresses a position.
          key={`${i}-${m.preview}`}
          className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
        >
          <HugeiconsIcon
            icon={Clock01Icon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0"
          />
          <span className="shrink-0 font-medium">Queued</span>
          <span className="min-w-0 flex-1 truncate">{m.preview}</span>
          <button
            type="button"
            onClick={() => cancelQueued(i)}
            title="Cancel this queued message"
            aria-label={`Cancel queued message: ${m.preview}`}
            className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <p className="px-0.5 text-[10px] text-muted-foreground/70">
        Sends when the current run finishes. Press stop to send it now.
      </p>
    </div>
  );
}
