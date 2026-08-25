import { useChatStore } from "../store/chatStore";
import { getModelContextLimit } from "../config";
import { cn } from "@/lib/utils";

/** Compact live context meter shown next to the agent controls. Reads the
 *  cumulative input tokens of the active run and shows them against the model's
 *  context window, so the user sees how full the context is before an auto
 *  compaction silently drops older tool results. */
export function ContextMeter() {
  const tokens = useChatStore((s) => s.agentMeta.tokens);
  const modelId = useChatStore((s) => s.selectedModelId);

  const used = tokens.inputTokens;
  if (used <= 0) return null;

  const limit = getModelContextLimit(modelId);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tone =
    pct > 90 ? "bg-destructive" : pct > 70 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 text-[11px] text-muted-foreground"
      title={`Context: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens · ${pct}%\
input ${tokens.inputTokens.toLocaleString()} · cached ${tokens.cachedInputTokens.toLocaleString()} · output ${tokens.outputTokens.toLocaleString()}`}
    >
      <span className="tabular-nums">{fmtK(used)} / {fmtK(limit)}</span>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full transition-all", tone)}
          style={{ width: `${pct}%` }}
        />
      </span>
    </button>
  );
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
