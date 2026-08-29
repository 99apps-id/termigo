import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveModelContextLimit } from "../config";
import { useChatStore } from "../store/chatStore";

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

  const endpoints = usePreferencesStore((s) => s.customEndpoints);
  const compatCtx = usePreferencesStore((s) => s.openaiCompatibleContextLimit);

  const used = lastInput;
  if (used <= 0) return null;

  const limit = resolveModelContextLimit(modelId, endpoints, compatCtx);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const left = Math.max(0, 100 - pct);
  // Three tiers, like Claude's context indicator: comfortable (accent), getting
  // full (amber), nearly out (red). The last is a real warning — the next step
  // may not fit and force a compaction.
  const tier = pct > 90 ? "danger" : pct > 75 ? "warn" : "ok";
  const fill =
    tier === "danger"
      ? "var(--destructive)"
      : tier === "warn"
        ? "#d1863a"
        : "var(--composer-accent)";
  const pctColor =
    tier === "danger"
      ? "text-destructive"
      : tier === "warn"
        ? "text-amber-500"
        : "text-foreground";

  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-card pl-1.5 pr-2 text-[11px] text-muted-foreground"
      title={`Context window: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens · ${pct}% used, ${left}% left (last request)\
cached ${lastCached.toLocaleString()} · run output ${tokens.outputTokens.toLocaleString()}`}
    >
      <span className="h-2 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: fill }}
        />
      </span>
      <span className={`font-medium tabular-nums ${pctColor}`}>{pct}%</span>
      <span className="tabular-nums text-muted-foreground/80">
        {fmtK(used)}/{fmtK(limit)}
      </span>
    </button>
  );
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
