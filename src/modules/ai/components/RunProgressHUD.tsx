import { cn } from "@/lib/utils";
import { activeTodoIndex } from "../lib/todos";
import { useChatStore } from "../store/chatStore";
import { useSubagentRunStore } from "../store/subagentRunStore";
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

const MAX_LIVE_SUBAGENTS = 4;

type SubagentRunLike = {
  id: string;
  type: string;
  label?: string;
  status: "running" | "done" | "error";
  currentStep?: string;
};

/**
 * Live progress HUD shown while an agent run is in flight: the step currently
 * being worked ("Running pnpm test"), the session's todo list with live status,
 * and the sub-agents currently running in a fan-out. Unlike the old status-bar
 * spinner text, this always renders during a run (not only when the last
 * message is the user's), so the user can see what task the agent is on, which
 * items remain — and, when the agent spawned a batch, which workers are still
 * out — the way BatikCode's todo checklist stays visible in the chat.
 *
 * The todo list is live: items appear the moment the agent writes them and
 * flip status as it marks them. When the model forgets to set the next item
 * `in_progress`, the first non-completed item is derived as "active" so there
 * is always a highlighted line matching the current step.
 *
 * Renders nothing when the run is idle or there is no progress to show.
 */
export function RunProgressHUD() {
  const status = useChatStore((s) => s.agentMeta.status);
  const step = useChatStore((s) => s.agentMeta.step);
  const sessionId = useChatStore((s) => s.activeSessionId);
  // Selectors return a STABLE reference (the store's own array, or undefined) —
  // a selector that built a fresh `?? []` here returned a new array every
  // render, which zustand v5's useSyncExternalStore reads as a change on every
  // snapshot and re-renders forever (the AI-chat-panel hang). The `?? []`
  // fallback happens outside the selector instead.
  const todos = useTodosStore(
    (s) =>
      s.bySession[sessionId ?? ""]?.items as
        | { id: string; title: string; status: string }[]
        | undefined,
  );
  const subRuns = useSubagentRunStore(
    (s) =>
      (sessionId ? s.bySession[sessionId] : undefined) as
        | SubagentRunLike[]
        | undefined,
  );

  const running =
    status === "streaming" ||
    status === "thinking" ||
    status === "awaiting-approval";
  if (!running) return null;

  const list = todos ?? [];
  const hasTodos = list.length > 0;
  const activeIdx = activeTodoIndex(
    list.map((t) => ({
      status: t.status as "pending" | "in_progress" | "completed",
    })),
  );
  const liveSubagents = (subRuns ?? [])
    .filter((r) => r.status === "running")
    .slice(-MAX_LIVE_SUBAGENTS);
  if (!step && !hasTodos && liveSubagents.length === 0) return null;

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
          {list.map((t, i) => {
            const isActive = i === activeIdx && t.status !== "completed";
            const icon =
              t.status === "completed"
                ? STATUS_ICON.completed
                : isActive
                  ? STATUS_ICON.in_progress
                  : STATUS_ICON.pending;
            return (
              <li
                key={t.id ?? t.title}
                className="flex items-start gap-2 text-[12px] leading-snug"
              >
                <span
                  className={cn(
                    "mt-px w-3.5 shrink-0 text-center text-[11px]",
                    t.status === "completed"
                      ? STATUS_STYLE.completed
                      : isActive
                        ? STATUS_STYLE.in_progress
                        : STATUS_STYLE.pending,
                  )}
                >
                  {icon}
                </span>
                <span
                  className={cn(
                    "min-w-0",
                    t.status === "completed"
                      ? "text-muted-foreground line-through decoration-muted-foreground/60"
                      : isActive
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
                >
                  {t.title}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {liveSubagents.length > 0 && (
        <div className="border-t border-border/50 pt-1.5">
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Sub-agents · {liveSubagents.length} running
          </div>
          <ul className="space-y-1">
            {liveSubagents.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 text-[12px] leading-snug"
              >
                <span className="relative flex size-1.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-violet-400" />
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  <span className="text-foreground">{r.label || r.type}</span>
                  {r.currentStep ? ` — ${r.currentStep}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
