import { cn } from "@/lib/utils";
import { useChatStore } from "../store/chatStore";
import { useTodosStore } from "../store/todoStore";

const STATUS_STYLE: Record<string, string> = {
  completed: "text-emerald-400",
  in_progress: "text-sky-400",
  pending: "text-muted-foreground",
};

const STATUS_ICON: Record<string, string> = {
  completed: "✓",
  in_progress: "●",
  pending: "○",
};

/**
 * Live progress HUD shown while an agent run is in flight: the step currently
 * being worked ("Running pnpm test") and the session's todo list with live
 * status. Unlike the old status-bar spinner text, this always renders during a
 * run (not only when the last message is the user's), so the user can see what
 * task the agent is on and which items remain — the way BatikCode's todo
 * checklist stays visible in the chat.
 *
 * Renders nothing when the run is idle or there is no progress to show.
 */
export function RunProgressHUD() {
  const status = useChatStore((s) => s.agentMeta.status);
  const step = useChatStore((s) => s.agentMeta.step);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const todos = useTodosStore(
    (s) =>
      (s.bySession[sessionId ?? ""]?.items ?? []) as
        | { id: string; title: string; status: string }[]
        | undefined,
  );

  const running =
    status === "streaming" ||
    status === "thinking" ||
    status === "awaiting-approval";
  if (!running) return null;

  const list = todos ?? [];
  const hasTodos = list.length > 0;
  if (!step && !hasTodos) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
      {step && (
        <div className="flex items-center gap-2 text-[12px] text-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
          </span>
          <span className="min-w-0 truncate">{step}</span>
        </div>
      )}
      {hasTodos && (
        <ul className="space-y-1">
          {list.map((t) => (
            <li
              key={t.id ?? t.title}
              className="flex items-start gap-2 text-[12px] leading-snug"
            >
              <span
                className={cn(
                  "mt-px w-3.5 shrink-0 text-center text-[11px]",
                  STATUS_STYLE[t.status] ?? STATUS_STYLE.pending,
                )}
              >
                {STATUS_ICON[t.status] ?? STATUS_ICON.pending}
              </span>
              <span
                className={cn(
                  "min-w-0",
                  t.status === "completed"
                    ? "text-muted-foreground line-through decoration-muted-foreground/60"
                    : t.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {t.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
