import { Shimmer } from "@/components/ai-elements/shimmer";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { resolveSubagentLabel } from "@/modules/ai/agents/resolveSubagent";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  type SubagentRun,
  useSubagentRunStore,
} from "@/modules/ai/store/subagentRunStore";
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  Clock01Icon,
  Copy01Icon,
  GitForkIcon,
  RobotIcon,
  Tick01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { memo, useCallback, useMemo, useState } from "react";

export type AnyToolPart = ToolUIPart | DynamicToolUIPart;

export type SubagentWorker = {
  index: number;
  type: string;
  label: string;
  prompt?: string;
  dependsOn?: number[];
  status: "pending" | "running" | "done" | "error" | "skipped";
  currentStep?: string;
  stepCount?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  skipped?: string;
};

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function extractWorkerData(
  toolName: string,
  input: unknown,
  output: unknown,
  runs: SubagentRun[] = [],
): {
  workers: SubagentWorker[];
  note?: string;
  maxConcurrency?: number;
} {
  const isBatch = toolName === "run_subagents";
  const inObj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : null;
  const outObj =
    output && typeof output === "object"
      ? (output as Record<string, unknown>)
      : null;

  const note = typeof outObj?.note === "string" ? outObj.note : undefined;
  const maxConcurrency =
    typeof outObj?.maxConcurrency === "number"
      ? outObj.maxConcurrency
      : typeof inObj?.max_concurrency === "number"
        ? inObj.max_concurrency
        : undefined;

  if (isBatch) {
    const rawTasks = Array.isArray(inObj?.tasks) ? inObj.tasks : [];
    const results = Array.isArray(outObj?.results)
      ? (outObj.results as Array<Record<string, unknown>>)
      : [];

    const workers: SubagentWorker[] = rawTasks.map((t, idx) => {
      const task = (t && typeof t === "object" ? t : {}) as Record<
        string,
        unknown
      >;
      const res = results[idx] ?? null;

      const rawType = String(res?.type ?? task.type ?? "general");
      const label = String(
        res?.description ??
          task.description ??
          (typeof task.prompt === "string"
            ? task.prompt.slice(0, 50).trim()
            : "") ||
          `Task #${idx}`,
      );

      const dependsOn = Array.isArray(task.depends_on)
        ? (task.depends_on as number[])
        : undefined;

      const matchedRun = runs.find(
        (r) =>
          r.type === rawType && (r.label === label || r.label === task.prompt),
      );

      const resError = typeof res?.error === "string" ? res.error : undefined;
      const resSkipped =
        typeof res?.skipped === "string" ? res.skipped : undefined;
      const resSummary =
        typeof res?.summary === "string" ? res.summary : undefined;
      const resStepCount =
        typeof res?.stepCount === "number" ? res.stepCount : undefined;
      const resDuration =
        typeof res?.durationMs === "number" ? res.durationMs : undefined;

      let status: SubagentWorker["status"] = "pending";
      if (resError || matchedRun?.status === "error") {
        status = "error";
      } else if (resSkipped) {
        status = "skipped";
      } else if (resSummary || matchedRun?.status === "done") {
        status = "done";
      } else if (matchedRun?.status === "running") {
        status = "running";
      }

      return {
        index: idx,
        type: rawType,
        label,
        prompt: typeof task.prompt === "string" ? task.prompt : undefined,
        dependsOn,
        status,
        currentStep: matchedRun?.currentStep,
        stepCount: resStepCount ?? matchedRun?.stepCount,
        durationMs: resDuration ?? matchedRun?.durationMs,
        summary: resSummary ?? matchedRun?.summary,
        error: resError ?? matchedRun?.error,
        skipped: resSkipped,
      };
    });

    return { workers, note, maxConcurrency };
  }

  // Single subagent
  const rawType = String(outObj?.type ?? inObj?.type ?? "general");
  const label = String(
    outObj?.description ??
      inObj?.description ??
      (typeof inObj?.prompt === "string"
        ? inObj.prompt.slice(0, 50).trim()
        : "") ||
      "Subagent",
  );

  const matchedRun = runs.find((r) => r.type === rawType);
  const outError = typeof outObj?.error === "string" ? outObj.error : undefined;
  const outSummary =
    typeof outObj?.summary === "string" ? outObj.summary : undefined;
  const outStepCount =
    typeof outObj?.stepCount === "number" ? outObj.stepCount : undefined;
  const outDuration =
    typeof outObj?.durationMs === "number" ? outObj.durationMs : undefined;

  let status: SubagentWorker["status"] = "pending";
  if (outError || matchedRun?.status === "error") {
    status = "error";
  } else if (outSummary || matchedRun?.status === "done") {
    status = "done";
  } else if (matchedRun?.status === "running") {
    status = "running";
  }

  const workers: SubagentWorker[] = [
    {
      index: 0,
      type: rawType,
      label,
      prompt: typeof inObj?.prompt === "string" ? inObj.prompt : undefined,
      status,
      currentStep: matchedRun?.currentStep,
      stepCount: outStepCount ?? matchedRun?.stepCount,
      durationMs: outDuration ?? matchedRun?.durationMs,
      summary: outSummary ?? matchedRun?.summary,
      error: outError ?? matchedRun?.error,
    },
  ];

  return { workers, note, maxConcurrency };
}

export const SubagentBatchCard = memo(function SubagentBatchCard({
  toolName,
  part,
  className,
}: {
  toolName: string;
  part: AnyToolPart;
  className?: string;
}) {
  const [open, setOpen] = useState(true);

  const input = part.input;
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;

  const sessionId = useChatStore((s) => s.activeSessionId) ?? "";
  const runs =
    useSubagentRunStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ??
    [];

  const { workers, note, maxConcurrency } = useMemo(
    () => extractWorkerData(toolName, input, output, runs),
    [toolName, input, output, runs],
  );

  const isBatch = toolName === "run_subagents";
  const inProgress =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    workers.some((w) => w.status === "running");

  const doneCount = workers.filter((w) => w.status === "done").length;
  const errorCount = workers.filter(
    (w) => w.status === "error" || w.status === "skipped",
  ).length;
  const runningCount = workers.filter((w) => w.status === "running").length;

  const totalDuration = workers.reduce(
    (acc, w) => acc + (w.durationMs ?? 0),
    0,
  );

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-lg border border-border/80 bg-card text-[12px] shadow-xs transition-all dark:border-border/70 dark:bg-card/60",
        inProgress && "border-primary/50 bg-primary/10 dark:border-primary/40 dark:bg-primary/5",
        errorCount > 0 && !inProgress && "border-amber-500/50",
        className,
      )}
    >
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((prev) => !prev);
          }
        }}
        className="flex w-full cursor-pointer items-center justify-between gap-2.5 px-3 py-2 text-left select-none hover:bg-muted/40"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            {inProgress ? (
              <Spinner className="size-3.5" />
            ) : (
              <HugeiconsIcon
                icon={RobotIcon}
                size={14}
                strokeWidth={1.8}
                className="text-primary"
              />
            )}
          </div>

          <span className="font-semibold text-foreground">
            {isBatch
              ? `Subagent Team (${workers.length} worker${workers.length === 1 ? "" : "s"})`
              : `Subagent: ${resolveSubagentLabel(workers[0]?.type ?? "general")}`}
          </span>

          {maxConcurrency != null && maxConcurrency > 1 && (
            <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              <HugeiconsIcon icon={GitForkIcon} size={10.5} strokeWidth={1.7} />
              <span>concurrency {maxConcurrency}</span>
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {inProgress ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
              <Shimmer as="span" duration={1} iterations="infinite">
                {runningCount > 0
                  ? `${runningCount} active`
                  : "Dispatching..."}
              </Shimmer>
            </span>
          ) : errorCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded border border-destructive/20 bg-destructive/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-destructive dark:border-transparent dark:bg-destructive/20 dark:text-red-300">
              <HugeiconsIcon icon={AlertCircleIcon} size={11} strokeWidth={2} />
              <span>{errorCount} issue{errorCount === 1 ? "" : "s"}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-800 dark:border-transparent dark:bg-emerald-500/20 dark:text-emerald-300">
              <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2} />
              <span>{doneCount} completed</span>
            </span>
          )}

          {totalDuration > 0 && (
            <span className="hidden sm:inline-flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
              <HugeiconsIcon icon={Clock01Icon} size={10.5} strokeWidth={1.8} />
              <span>{fmtDuration(totalDuration)}</span>
            </span>
          )}

          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2}
            className={cn(
              "text-muted-foreground transition-transform duration-150",
              open ? "rotate-90" : "rotate-0",
            )}
          />
        </div>
      </div>

      {open && (
        <div className="border-t border-border/40 p-2.5 space-y-2">
          {/* Note or Conflict warning banner */}
          {note && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/15 p-2 text-[11px] font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <HugeiconsIcon
                icon={AlertCircleIcon}
                size={13}
                strokeWidth={2}
                className="mt-0.5 shrink-0"
              />
              <span className="leading-relaxed">{note}</span>
            </div>
          )}

          {errorText && (
            <div className="rounded-md border border-destructive/30 bg-destructive/15 p-2 text-[11px] font-medium text-destructive whitespace-pre-wrap dark:bg-destructive/10 dark:text-red-300">
              {errorText}
            </div>
          )}

          {/* Workers list */}
          <div className="space-y-1.5">
            {workers.map((worker) => (
              <WorkerRow key={worker.index} worker={worker} isBatch={isBatch} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

const WorkerRow = memo(function WorkerRow({
  worker,
  isBatch,
}: {
  worker: SubagentWorker;
  isBatch: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const roleName = resolveSubagentLabel(worker.type);
  const isRunning = worker.status === "running";
  const isDone = worker.status === "done";
  const isError = worker.status === "error";
  const isSkipped = worker.status === "skipped";

  const handleCopySummary = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!worker.summary) return;
      void navigator.clipboard.writeText(worker.summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    },
    [worker.summary],
  );

  return (
    <div
      className={cn(
        "rounded-md border border-border/80 bg-card p-2 shadow-2xs transition-all dark:border-border/50 dark:bg-background/50",
        isRunning && "border-primary/50 bg-primary/10 dark:border-primary/40 dark:bg-primary/5",
        isError && "border-destructive/40 bg-destructive/10 dark:bg-destructive/5",
        isSkipped && "border-border/40 opacity-75 dark:border-border/30",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (worker.summary) setExpanded((p) => !p);
        }}
        onKeyDown={(e) => {
          if (worker.summary && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setExpanded((p) => !p);
          }
        }}
        className={cn(
          "flex items-start justify-between gap-2 select-none",
          worker.summary && "cursor-pointer hover:opacity-90",
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
            {isRunning ? (
              <Spinner className="size-3 text-primary" />
            ) : isDone ? (
              <span className="size-2 rounded-full bg-emerald-500" />
            ) : isError ? (
              <span className="size-2 rounded-full bg-destructive" />
            ) : isSkipped ? (
              <span className="size-2 rounded-full bg-amber-500" />
            ) : (
              <span className="size-2 rounded-full bg-muted-foreground/40" />
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {isBatch && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  #{worker.index}
                </span>
              )}

              <span className="rounded border border-border/60 bg-muted px-1.5 py-0.5 font-medium text-foreground text-[10px]">
                {roleName}
              </span>

              {worker.dependsOn && worker.dependsOn.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.2 text-[9.5px] text-muted-foreground">
                  <HugeiconsIcon icon={GitForkIcon} size={9} strokeWidth={1.8} />
                  <span>waits for #{worker.dependsOn.join(", #")}</span>
                </span>
              )}

              <span className="font-medium text-foreground truncate max-w-xs sm:max-w-md">
                {worker.label}
              </span>
            </div>

            {isRunning && worker.currentStep && (
              <div className="font-mono text-[10.5px] text-primary">
                <Shimmer as="span" duration={1} iterations="infinite">
                  -&gt; {worker.currentStep}
                </Shimmer>
              </div>
            )}

            {isError && worker.error && (
              <div className="font-mono text-[10.5px] text-destructive">
                {worker.error}
              </div>
            )}

            {isSkipped && (
              <div className="font-mono text-[10.5px] text-amber-700 dark:text-amber-400">
                Skipped: {worker.skipped || "dependency failed"}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 text-[10.5px] font-mono text-muted-foreground">
          {worker.stepCount != null && (
            <span>
              {worker.stepCount} step{worker.stepCount === 1 ? "" : "s"}
            </span>
          )}
          {worker.durationMs != null && worker.durationMs > 0 && (
            <span>{fmtDuration(worker.durationMs)}</span>
          )}

          {worker.summary && (
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={11}
              strokeWidth={2}
              className={cn(
                "transition-transform duration-150",
                expanded ? "rotate-90" : "rotate-0",
              )}
            />
          )}
        </div>
      </div>

      {expanded && worker.summary && (
        <div className="mt-2 border-t border-border/40 pt-2 text-[11px] leading-relaxed">
          <div className="flex items-center justify-between pb-1 text-[10px] text-muted-foreground">
            <span className="font-medium uppercase tracking-wider">Summary</span>
            <button
              type="button"
              onClick={handleCopySummary}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
            >
              <HugeiconsIcon
                icon={copied ? Tick01Icon : Copy01Icon}
                size={10}
                strokeWidth={1.8}
              />
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
          <div className="rounded border border-border/60 bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap select-text text-foreground dark:bg-muted/20">
            {worker.summary}
          </div>
        </div>
      )}
    </div>
  );
});
