import {
  Cancel01Icon,
  Clock01Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useComposer } from "../lib/composer";
import { getQueueWindow } from "../lib/steer";

/**
 * Messages typed while the agent is working, shown above the input.
 *
 * Steering is only trustworthy if it is visible. Silently holding text would be
 * no better than the old behaviour of silently dropping it: either way the user
 * cannot tell whether the app took what they typed. Each row says what is
 * waiting and offers a way to take it back or revise it before it sends.
 *
 * The strip is windowed (Hermes' QueuedMessages pattern): a count header, at
 * most QUEUE_WINDOW numbered rows, and ellipsis markers for what is hidden, so
 * a long queue never crowds out the composer it sits above.
 */
export function QueuedSteerRow() {
  const { queued, cancelQueued, editQueued } = useComposer();
  if (queued.length === 0) return null;

  const win = getQueueWindow(queued.length);
  const shown = queued.slice(win.start, win.end);

  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-0.5 text-[10px] text-muted-foreground/80">
        queued ({queued.length}) · sends when this run finishes · stop to send
        now
      </p>
      {win.showLead && (
        <p className="px-2 text-[10px] text-muted-foreground/60">…</p>
      )}
      {shown.map((m, i) => {
        const idx = win.start + i;
        return (
          <div
            // The queue is an ordered buffer with no stable ids; position plus
            // preview is the identity cancel/edit address.
            key={`${idx}-${m.preview}`}
            className="group flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
          >
            <HugeiconsIcon
              icon={Clock01Icon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <span className="shrink-0 font-medium tabular-nums">{idx + 1}.</span>
            <span className="min-w-0 flex-1 truncate">{m.preview}</span>
            <button
              type="button"
              onClick={() => editQueued(idx)}
              title="Edit — move this message back into the composer"
              aria-label={`Edit queued message ${idx + 1}: ${m.preview}`}
              className="shrink-0 rounded p-0.5 opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100"
            >
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={12}
                strokeWidth={1.75}
              />
            </button>
            <button
              type="button"
              onClick={() => cancelQueued(idx)}
              title="Cancel this queued message"
              aria-label={`Cancel queued message ${idx + 1}: ${m.preview}`}
              className="shrink-0 rounded p-0.5 opacity-60 hover:bg-accent hover:text-destructive hover:opacity-100"
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                size={12}
                strokeWidth={1.75}
              />
            </button>
          </div>
        );
      })}
      {win.showTail && (
        <p className="px-2 text-[10px] text-muted-foreground/60">
          …and {queued.length - win.end} more
        </p>
      )}
    </div>
  );
}
