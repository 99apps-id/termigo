import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import {
  aggregateByDay,
  aggregateByModel,
  type CostEntry,
  dayKey,
  entriesForWorkspace,
  entriesOnDay,
  loadCostLedger,
  sumCost,
} from "../lib/costLedger";
import { useChatStore } from "../store/chatStore";

/** Format a USD amount: cents-precision below $1 so a $0.0043 run is legible,
 *  two decimals above. */
function usd(n: number): string {
  if (n <= 0) return "$0";
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Spend panel — the `/cost` view: what the agent has cost, all-time and today,
 * broken down by model and by day. Reads the persistent per-run ledger, so the
 * numbers survive restarts. Estimates only, from token counts × model pricing.
 */
export function CostPanel() {
  const [entries, setEntries] = useState<CostEntry[] | null>(null);
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());

  useEffect(() => {
    let alive = true;
    void loadCostLedger()
      .then((e) => {
        if (alive) setEntries(e);
      })
      .catch(() => {
        if (alive) setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const stats = useMemo(() => {
    if (!entries) return null;
    const today = dayKey(Date.now());
    return {
      total: sumCost(entries),
      today: sumCost(entriesOnDay(entries, today)),
      workspace: sumCost(entriesForWorkspace(entries, workspaceRoot)),
      runs: entries.length,
      byModel: aggregateByModel(entries),
      byDay: aggregateByDay(entries, 14),
    };
  }, [entries, workspaceRoot]);

  if (!stats) {
    return (
      <p className="p-4 text-center text-[11px] text-muted-foreground">
        Loading cost ledger…
      </p>
    );
  }

  if (stats.runs === 0) {
    return (
      <p className="p-4 text-center text-[11px] text-muted-foreground">
        No spend recorded yet. Each finished run on a priced model appends one
        entry; unknown-price models record nothing.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-1 text-xs">
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="All time"
          value={usd(stats.total)}
          sub={`${stats.runs} runs`}
        />
        <Stat label="Today" value={usd(stats.today)} />
        <Stat
          label="This project"
          value={usd(stats.workspace)}
          sub={workspaceRoot ? undefined : "no workspace"}
        />
      </div>

      <Section title="By model">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Model</th>
              <th className="py-1 px-2 text-right font-medium">Cost</th>
              <th className="py-1 px-2 text-right font-medium">In</th>
              <th className="py-1 px-2 text-right font-medium">Out</th>
              <th className="py-1 pl-2 text-right font-medium">Runs</th>
            </tr>
          </thead>
          <tbody>
            {stats.byModel.map((m) => (
              <tr key={m.modelId} className="border-t border-border/40">
                <td className="py-1 pr-2">
                  <div className="font-mono text-foreground">{m.modelId}</div>
                  <div className="text-[9px] text-muted-foreground">
                    {m.provider}
                  </div>
                </td>
                <td className="py-1 px-2 text-right font-medium tabular-nums text-foreground">
                  {usd(m.costUsd)}
                </td>
                <td className="py-1 px-2 text-right tabular-nums text-muted-foreground">
                  {fmtK(m.inputTokens)}
                </td>
                <td className="py-1 px-2 text-right tabular-nums text-muted-foreground">
                  {fmtK(m.outputTokens)}
                </td>
                <td className="py-1 pl-2 text-right tabular-nums text-muted-foreground">
                  {m.runs}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Last 14 days">
        <DayBars days={stats.byDay} />
      </Section>

      <p className="text-[10px] leading-snug text-muted-foreground">
        Estimates from token counts × model pricing, kept ~3 months. Providers
        bill from their own metering — treat these as a guide, not an invoice.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-2.5">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {sub && <div className="text-[9px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

/** A tiny horizontal bar chart of daily spend, so the trend reads at a glance
 *  without a chart library. */
function DayBars({
  days,
}: {
  days: { day: string; costUsd: number; runs: number }[];
}) {
  const max = Math.max(...days.map((d) => d.costUsd), 0.0001);
  return (
    <div className="flex flex-col gap-1">
      {days.map((d) => (
        <div key={d.day} className="flex items-center gap-2">
          <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">
            {d.day.slice(5)}
          </span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full rounded-full")}
              style={{
                width: `${Math.max(2, (d.costUsd / max) * 100)}%`,
                backgroundColor: "var(--composer-accent)",
              }}
            />
          </span>
          <span className="w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-foreground">
            {usd(d.costUsd)}
          </span>
        </div>
      ))}
    </div>
  );
}
