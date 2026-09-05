import { useState } from "react";
import { BrainIcon, TerminalIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/ai-elements/shimmer";

export type ThoughtNode = {
  id: string;
  title: string;
  type: "thinking" | "tool" | "check" | "plan";
  status: "running" | "completed" | "failed";
  details?: string;
  durationMs?: number;
  substeps?: ThoughtNode[];
};

export function ThinkingTreeHUD({
  nodes,
  className,
  defaultExpanded = true,
}: {
  nodes: ThoughtNode[];
  className?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!nodes || nodes.length === 0) return null;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/80 bg-card p-2.5 text-xs shadow-xs transition-all dark:border-border/50 dark:bg-card/60",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between font-mono text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
          <span>Agent Execution & Reasoning ({nodes.length} steps)</span>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {expanded ? "Collapse" : "Expand"}
        </span>
      </button>

      {expanded && (
        <div className="mt-2.5 space-y-1.5 border-t border-border/30 pt-2 font-mono text-[11px]">
          {nodes.map((node) => (
            <div
              key={node.id}
              className="flex items-start justify-between rounded p-1.5 hover:bg-muted/50"
            >
              <div className="flex items-start gap-2 overflow-hidden pr-2">
                <span className="mt-0.5 shrink-0 text-muted-foreground">
                  {node.type === "tool" ? (
                    <HugeiconsIcon icon={TerminalIcon} size={12} />
                  ) : node.type === "check" ? (
                    <HugeiconsIcon icon={Tick01Icon} size={12} />
                  ) : (
                    <HugeiconsIcon icon={BrainIcon} size={12} />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">
                    <Shimmer
                      as="span"
                      duration={node.status === "running" ? 1 : 1.4}
                      iterations={node.status === "running" ? "infinite" : 2}
                      className="truncate font-medium text-foreground"
                    >
                      {node.title}
                    </Shimmer>
                  </div>
                  {node.details && (
                    <div className="text-[10px] text-muted-foreground truncate">{node.details}</div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {node.durationMs != null && (
                  <span className="text-[10px] text-muted-foreground">{node.durationMs}ms</span>
                )}
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[9px] uppercase",
                    node.status === "completed"
                      ? "border border-emerald-500/20 bg-emerald-500/15 font-semibold text-emerald-800 dark:border-transparent dark:bg-emerald-500/10 dark:text-emerald-400"
                      : node.status === "running"
                        ? "border border-blue-500/20 bg-blue-500/15 font-semibold text-blue-700 animate-pulse dark:border-transparent dark:bg-blue-500/10 dark:text-blue-400"
                        : "border border-destructive/20 bg-destructive/15 font-semibold text-destructive dark:border-transparent dark:bg-destructive/10 dark:text-red-300",
                  )}
                >
                  {node.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
