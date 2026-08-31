import { cn } from "@/lib/utils";
import { useConfirmationStore } from "../store/confirmationStore";

/**
 * Renders pending post-execution confirmations as Keep / Revert cards
 * (BatikCode `chatToolPostExecuteConfirmationPart` parity). After a mutating
 * tool succeeds, the run pauses until the user picks; Revert restores the
 * touched paths from git. Renders nothing when idle or disabled.
 */
export function ConfirmationCarousel() {
  const pending = useConfirmationStore((s) => s.pending);
  const resolve = useConfirmationStore((s) => s.resolve);

  if (pending.length === 0) return null;

  return (
    <div className="space-y-2">
      {pending.map((c) => (
        <div
          key={c.id}
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5"
        >
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground">
              <span className="font-medium">Keep this change?</span>{" "}
              <span className="text-muted-foreground">{c.summary}</span>
            </span>
          </div>
          {c.touchedPaths.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {c.touchedPaths.map((p) => (
                <span
                  key={p}
                  className="max-w-full truncate rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground"
                  title={p}
                >
                  {p}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => resolve(c.id, true)}
              className={cn(
                "rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11.5px] font-medium text-emerald-300 transition-colors",
                "hover:bg-emerald-500/20",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              Keep
            </button>
            <button
              type="button"
              onClick={() => resolve(c.id, false)}
              className={cn(
                "rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11.5px] font-medium text-red-300 transition-colors",
                "hover:bg-red-500/20",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              Revert
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
