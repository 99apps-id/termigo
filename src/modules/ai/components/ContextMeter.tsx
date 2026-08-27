import { useChatStore } from "../store/chatStore";
import { getModelContextLimit } from "../config";

/** Compact live context meter shown next to the agent controls. Shows how full
 *  the model's context window is RIGHT NOW - the input of the most recent
 *  request, not the run's cumulative input. Cumulative input sums every step
 *  (each re-sends the growing history), so it blows past the window and pins the
 *  bar red even though no single request was ever over the limit. The
 *  last-request value tracks the true fill and DROPS when auto-compaction evicts
 *  old tool results, instead of only ever climbing. */
export function ContextMeter() {
  const lastInput = useChatStore((s) => s.agentMeta.lastInputTokens);
  const lastCached = useChatStore((s) => s.agentMeta.lastCachedTokens);
  const tokens = useChatStore((s) => s.agentMeta.tokens);
  const modelId = useChatStore((s) => s.selectedModelId);

  const used = lastInput;
  if (used <= 0) return null;

  const limit = getModelContextLimit(modelId);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  // The accent orange, shared with the composer glow and send/stop button; only
  // an over-90% window turns red as a warning.
  const fill = pct > 90 ? "var(--destructive)" : "var(--composer-accent)";

  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 text-[11px] text-muted-foreground"
      title={`Context window: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens · ${pct}% (last request)\
cached ${lastCached.toLocaleString()} · run output ${tokens.outputTokens.toLocaleString()}`}
    >
      <span className="tabular-nums">{fmtK(used)} / {fmtK(limit)}</span>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: fill }}
        />
      </span>
    </button>
  );
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
