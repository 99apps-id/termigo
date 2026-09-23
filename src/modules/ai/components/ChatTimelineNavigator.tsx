import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ArrowTurnBackwardIcon, Compass01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UIMessage } from "ai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { type TurnCheckpoint, turnLabelFor } from "../lib/turnCheckpoints";
import { useTurnCheckpointStore } from "../store/turnCheckpointStore";

export type UserTurnMarker = {
  messageId: string;
  turnIndex: number;
  label: string;
  hasCheckpoint: boolean;
  partCount: number;
};

export type ChatTimelineNavigatorProps = {
  messages: UIMessage[];
  sessionId: string | null;
  className?: string;
};

const EMPTY_CHECKPOINTS: TurnCheckpoint[] = [];

/**
 * Timeline navigator (mini-map for user turns).
 *
 * Appears when conversations grow (especially 200+ parts or multiple user turns).
 * Provides a mini-map rail where each user turn is a waypoint.
 * Hovering shows the turn prompt snippet & checkpoint status; clicking smoothly
 * scrolls to that turn in the transcript.
 */
export const ChatTimelineNavigator = memo(function ChatTimelineNavigator({
  messages,
  sessionId,
  className,
}: ChatTimelineNavigatorProps) {
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Checkpoints for this session - use stable fallback reference to prevent re-render thrashing
  const checkpoints = useTurnCheckpointStore((s) =>
    sessionId ? s.bySession[sessionId] ?? EMPTY_CHECKPOINTS : EMPTY_CHECKPOINTS,
  );

  const checkpointMap = useMemo(() => {
    const set = new Set<string>();
    for (const cp of checkpoints) set.add(cp.messageId);
    return set;
  }, [checkpoints]);

  // Extract user turns and their approximate parts count
  const turns = useMemo<UserTurnMarker[]>(() => {
    const result: UserTurnMarker[] = [];
    let turnCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user") continue;

      turnCount++;
      const text = msg.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      // Count parts until next user turn
      let partCount = msg.parts.length;
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === "user") break;
        partCount += messages[j].parts.length;
      }

      result.push({
        messageId: msg.id,
        turnIndex: turnCount,
        label: turnLabelFor(text) ?? `Turn ${turnCount}`,
        hasCheckpoint: checkpointMap.has(msg.id),
        partCount,
      });
    }

    return result;
  }, [messages, checkpointMap]);

  // Total parts across the transcript
  const totalParts = useMemo(
    () => messages.reduce((sum, m) => sum + (m.parts?.length ?? 1), 0),
    [messages],
  );

  // Stable string signature of turn message IDs so observer only reconnects on structural turn changes
  const turnIds = useMemo(
    () => turns.map((t) => t.messageId).join(","),
    [turns],
  );

  // Track active turn in viewport using IntersectionObserver
  useEffect(() => {
    if (turns.length < 2) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("data-message-id");
            if (id) {
              setActiveMessageId((prev) => (prev === id ? prev : id));
              break;
            }
          }
        }
      },
      {
        rootMargin: "-20% 0px -60% 0px",
        threshold: 0.1,
      },
    );

    for (const turn of turns) {
      const el = document.getElementById(`msg-${turn.messageId}`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [turnIds, turns.length]);

  const scrollToTurn = useCallback((messageId: string) => {
    const el =
      document.getElementById(`msg-${messageId}`) ||
      document.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveMessageId(messageId);
    }
  }, []);

  // Show navigator when there are 2 or more user turns
  if (turns.length < 2) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        aria-label="Conversation timeline"
        className={cn(
          "absolute right-2.5 top-12 z-20 flex flex-col items-end gap-1.5 transition-all",
          className,
        )}
      >
        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/85 px-1.5 py-0.5 shadow-sm backdrop-blur">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-1 text-[9.5px] font-mono font-medium text-muted-foreground hover:text-foreground"
            title={`${turns.length} turns · ${totalParts} parts in transcript (click to ${collapsed ? "expand" : "collapse"})`}
          >
            <HugeiconsIcon icon={Compass01Icon} size={11} strokeWidth={2} />
            {!collapsed && (
              <span>
                {turns.length}T · {totalParts}p
              </span>
            )}
          </button>
        </div>

        {!collapsed && (
          <nav
            aria-label="Turn waypoints"
            className="flex flex-col items-center gap-1 rounded-full border border-border/50 bg-background/80 py-1.5 px-1 shadow-sm backdrop-blur"
          >
            {turns.map((t) => {
              const isActive = activeMessageId === t.messageId;
              return (
                <Tooltip key={t.messageId}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => scrollToTurn(t.messageId)}
                      aria-label={`Jump to turn ${t.turnIndex}: ${t.label}`}
                      className={cn(
                        "relative flex size-5 items-center justify-center rounded-full text-[9px] font-mono font-bold transition-all",
                        isActive
                          ? "bg-primary text-primary-foreground scale-110 shadow-xs ring-1 ring-primary/40"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        t.hasCheckpoint &&
                          !isActive &&
                          "ring-1 ring-sky-500/40 text-sky-600 dark:text-sky-400",
                      )}
                    >
                      {t.turnIndex}
                      {t.hasCheckpoint && (
                        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-sky-500" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-64 text-left p-2">
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                      <span className="font-semibold text-foreground">
                        Turn #{t.turnIndex}
                      </span>
                      <span>· {t.partCount} parts</span>
                      {t.hasCheckpoint && (
                        <span className="inline-flex items-center gap-0.5 text-sky-600 dark:text-sky-400">
                          <HugeiconsIcon
                            icon={ArrowTurnBackwardIcon}
                            size={9}
                            strokeWidth={2}
                          />
                          checkpoint
                        </span>
                      )}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-foreground/90">
                      {t.label}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </nav>
        )}
      </aside>
    </TooltipProvider>
  );
});
