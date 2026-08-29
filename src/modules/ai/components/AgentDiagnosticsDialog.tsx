import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { type ReactNode, useMemo, useState } from "react";
import { useChatStore } from "../store/chatStore";
import { type DebugCapture, useDebugStore } from "../store/debugStore";
import { CostPanel } from "./CostPanel";
import { RunSummary } from "./RunDiagnosticsDialog";
import { RunJourney } from "./RunJourney";

type Tab = "run" | "requests" | "context" | "cost" | "journey";

const TABS: { id: Tab; label: string }[] = [
  { id: "run", label: "Run" },
  { id: "requests", label: "Requests" },
  { id: "context", label: "Context" },
  { id: "cost", label: "Cost" },
  { id: "journey", label: "Journey" },
];

/**
 * One surface for the three observability views that used to be scattered:
 * the last run's performance summary, the raw requests sent to the provider,
 * and the agent's live context/cost state.
 */
export function AgentDiagnosticsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("run");
  const lastRun = useChatStore((s) => s.lastRun);
  const agentMeta = useChatStore((s) => s.agentMeta);
  const captures = useDebugStore((s) => s.captures);
  const clear = useDebugStore((s) => s.clear);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected =
    captures.find((c) => c.id === selectedId) ?? captures[0] ?? null;
  const json = useMemo(
    () => (selected ? JSON.stringify(selected, null, 2) : ""),
    [selected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="text-[13px]">Agent diagnostics</DialogTitle>
        </DialogHeader>

        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                tab === t.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "run" ? (
            lastRun ? (
              <RunSummary run={lastRun} />
            ) : (
              <Empty>
                No run measured yet. The next agent run will appear here with
                its context-assembly time, prompt size breakdown, cache hit rate
                and why it stopped.
              </Empty>
            )
          ) : tab === "requests" ? (
            captures.length === 0 ? (
              <Empty>
                Nothing captured yet. Turn on Settings → Agents → Diagnostics →
                Capture requests, then the next step the agent sends appears
                here — one entry per step.
              </Empty>
            ) : (
              <div className="flex min-h-0 gap-3">
                <ul className="w-56 shrink-0 space-y-1 overflow-y-auto pr-1">
                  {captures.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(c.id)}
                        className={cn(
                          "w-full rounded-md border px-2 py-1.5 text-left text-[10px] leading-tight transition-colors",
                          selected?.id === c.id
                            ? "border-border bg-accent text-foreground"
                            : "border-transparent text-muted-foreground hover:bg-accent/50",
                        )}
                      >
                        <div className="font-medium">{captureSummary(c)}</div>
                        <div className="mt-0.5 opacity-70">
                          {new Date(c.at).toLocaleTimeString()} · {c.model.id}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
                <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card/60 p-2.5 text-[10px] leading-relaxed">
                  {json}
                </pre>
              </div>
            )
          ) : tab === "journey" ? (
            <RunJourney />
          ) : tab === "cost" ? (
            <CostPanel />
          ) : (
            <ContextView
              modelId={lastRun?.modelId ?? null}
              provider={lastRun?.provider ?? null}
              lastInputTokens={agentMeta.lastInputTokens}
              lastCachedTokens={agentMeta.lastCachedTokens}
              totalRunTokens={agentMeta.tokens.inputTokens}
              runRound={agentMeta.runRound}
              stopReason={agentMeta.stopReason}
              approvalsPending={agentMeta.approvalsPending}
              status={agentMeta.status}
            />
          )}
        </div>

        {tab === "requests" && captures.length > 0 && (
          <div className="flex items-center justify-end gap-1.5 border-t border-border pt-2.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={!selected}
              onClick={() => void navigator.clipboard?.writeText(json)}
            >
              Copy JSON
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                clear();
                setSelectedId(null);
              }}
            >
              Clear
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center px-6 py-10 text-center text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-right text-[11.5px] font-medium text-foreground">
        {value}
        {hint ? (
          <span className="ml-1 font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </div>
  );
}

function ContextView({
  modelId,
  provider,
  lastInputTokens,
  lastCachedTokens,
  totalRunTokens,
  runRound,
  stopReason,
  approvalsPending,
  status,
}: {
  modelId: string | null;
  provider: string | null;
  lastInputTokens: number;
  lastCachedTokens: number;
  totalRunTokens: number;
  runRound: number;
  stopReason: string | null;
  approvalsPending: number;
  status: string;
}) {
  const cachePct =
    lastInputTokens > 0
      ? Math.round((lastCachedTokens / lastInputTokens) * 100)
      : 0;
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-1">
        <Row label="Model" value={modelId ?? "—"} />
        <Row label="Provider" value={provider ?? "—"} />
      </div>
      <Row label="Status" value={status} />
      <Row
        label="Last request"
        value={`${lastInputTokens} tokens`}
        hint={`${lastCachedTokens} cached (${cachePct}%)`}
      />
      <Row label="Total run tokens" value={totalRunTokens.toLocaleString()} />
      <Row label="Run round" value={`${runRound}`} />
      <Row label="Approvals pending" value={`${approvalsPending}`} />
      <Row label="Last stop reason" value={stopReason ?? "—"} />
      <Row
        label="Notes"
        value=""
        hint="Call context_report from the agent to see files read this session."
      />
    </div>
  );
}

/** One line that says what this request step was, without opening it. */
function captureSummary(c: DebugCapture): string {
  const messages = Array.isArray(c.messages) ? c.messages.length : 0;
  const budget = c.params.stepBudget;
  return `${messages} msg · ${c.tools.length} tools${
    typeof budget === "number" ? ` · ${budget} steps` : ""
  }`;
}
