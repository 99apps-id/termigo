import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  CheckmarkSquare02Icon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { Todo } from "../lib/todos";
import { belongsToWorkspace, EMPTY_RECORD, isFinished } from "../lib/todos";
import { useChatStore } from "../store/chatStore";
import { useTodosStore } from "../store/todoStore";

type Props = { sessionId: string | null };

export function TodoStrip({ sessionId }: Props) {
  const [isMinimized, setIsMinimized] = useState(false);
  const hydrate = useTodosStore((s) => s.hydrate);
  const record =
    useTodosStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ??
    EMPTY_RECORD;
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  if (!sessionId || record.items.length === 0) return null;
  // A chat session outlives the project it was started in, so a list written
  // for another workspace is not this project's work and must not sit on top
  // of it.
  if (!belongsToWorkspace(record, workspaceRoot)) return null;
  // Done is done. The strip used to check only whether the list was empty, so
  // a finished run left a 5/5 bar holding up to 35% of the panel until the
  // session was deleted. The list stays on disk; it just stops taking space.
  if (isFinished(record.items)) return null;

  const todos = record.items;

  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const pct = Math.round((completed / todos.length) * 100);

  return (
    <div
      className={cn(
        "flex flex-col min-h-0 shrink-0 border-t-2 border-border/80 bg-card px-3 py-1.5 shadow-[0_-4px_12px_-8px_rgba(0,0,0,0.15)] transition-all duration-200 ease-in-out dark:border-border/40 dark:bg-muted/80 dark:shadow-[0_-4px_12px_-8px_rgba(0,0,0,0.2)]",
        isMinimized ? "max-h-[38px]" : "max-h-[35%]",
      )}
    >
      <div className="my-1 flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => setIsMinimized((prev) => !prev)}
          className="flex items-center gap-1.5 rounded text-left hover:opacity-80 transition-opacity"
        >
          <Shimmer
            as="span"
            duration={inProgress > 0 ? 1 : 1.4}
            iterations={inProgress > 0 ? "infinite" : 2}
            className="text-[11px] font-semibold text-foreground"
          >
            Todos
          </Shimmer>
        </button>

        <Progress value={pct} className="h-1 flex-1" />

        <span className="text-[11px] tabular-nums font-mono text-muted-foreground">
          {completed}/{todos.length}
        </span>

        <button
          type="button"
          onClick={() => setIsMinimized((prev) => !prev)}
          className="flex items-center justify-center p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-background/40 transition-colors"
          title={isMinimized ? "Expand Todos list" : "Minimize Todos list"}
          aria-label={isMinimized ? "Expand Todos list" : "Minimize Todos list"}
        >
          <HugeiconsIcon
            icon={isMinimized ? ArrowUp01Icon : ArrowDown01Icon}
            size={13}
            strokeWidth={2}
          />
        </button>
      </div>

      {!isMinimized && (
        <ScrollArea className="flex-1 min-h-0 pt-0.5 animate-in fade-in-0 duration-150">
          <ul className="flex flex-col gap-0.5">
            {todos.map((t) => (
              <TodoRow key={t.id} todo={t} />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  const isInProgress = todo.status === "in_progress";
  const row = (
    <li
      className={cn(
        "flex items-start gap-2 rounded px-1.5 py-1 text-[11px] leading-snug",
        isInProgress && "border-l-2 border-primary bg-primary/10 dark:border-foreground/50 dark:bg-muted/40",
      )}
    >
      <span className="mt-[2px] inline-flex size-3.5 shrink-0 items-center justify-center">
        {isInProgress ? (
          <Spinner className="size-3 text-primary" />
        ) : (
          <HugeiconsIcon
            icon={
              todo.status === "completed" ? CheckmarkSquare02Icon : SquareIcon
            }
            strokeWidth={1.75}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          todo.status === "completed"
            ? "text-muted-foreground line-through opacity-70"
            : isInProgress
              ? "text-foreground font-medium"
              : "text-muted-foreground",
        )}
      >
        {todo.title}
      </span>
    </li>
  );

  if (!todo.description) return row;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs text-[11px]">
          {todo.description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
