import { cn } from "@/lib/utils";
import { useElicitationStore } from "../store/elicitationStore";

/**
 * Renders pending `ask_user` questions as clickable choosers (BatikCode
 * `chatQuestionCarouselPart` parity). Clicking an option answers the awaiting
 * tool call; the dismiss button cancels it. Renders nothing when idle.
 */
export function ElicitationCarousel() {
  const pending = useElicitationStore((s) => s.pending);
  const answer = useElicitationStore((s) => s.answer);
  const cancel = useElicitationStore((s) => s.cancel);

  if (pending.length === 0) return null;

  return (
    <div className="space-y-2">
      {pending.map((q) => (
        <div
          key={q.id}
          className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2.5"
        >
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground">
              {q.question}
            </span>
            <button
              type="button"
              onClick={() => cancel(q.id)}
              aria-label="Dismiss question"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path
                  d="M3 3l6 6M9 3l-6 6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {q.options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => answer(q.id, opt)}
                className={cn(
                  "rounded-md border border-border/60 bg-background/70 px-2.5 py-1 text-left text-[11.5px] text-foreground transition-colors",
                  "hover:border-primary/50 hover:bg-primary/10",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
