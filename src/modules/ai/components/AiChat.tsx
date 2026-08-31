import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  type MessageResponseProps,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  MarkdownLink,
  type MarkdownLinkProps,
} from "@/modules/markdown/MarkdownLink";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  ArrowRight01Icon,
  CodeIcon,
  Edit02Icon,
  File01Icon,
  HashtagIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { stepBudgetForRound } from "../config";
import { useAutoApproval } from "../hooks/useAutoApproval";
import type { AgentStopReason } from "../lib/agent";
import { humanizeModelError } from "../lib/errorMessage";
import { SLASH_COMMANDS, TERMIGO_CMD_RE } from "../lib/slashCommands";
import { resumeRun } from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
import { AiToolApproval } from "./AiToolApproval";
import { ConfirmationCarousel } from "./ConfirmationCarousel";
import { ElicitationCarousel } from "./ElicitationCarousel";
import { RollbackSuggestion } from "./RollbackSuggestion";
import { TrajectoryThinkingHUD } from "./TrajectoryThinkingHUD";

/**
 * Rotating "working" phrases, in the style of VS Code's chat thinking part
 * (`chatThinkingContentPart`) — a calm status word that cycles while the model
 * is thinking (no tool step active yet) instead of a static "Thinking…". No
 * round labels: Termigo surfaces progress through the step HUD, not a counter.
 */
const THINKING_PHRASES = [
  "Processing",
  "Preparing",
  "Loading",
  "Analyzing",
  "Evaluating",
] as const;

function useRotatingPhrase(active: boolean, intervalMs = 2200): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % THINKING_PHRASES.length),
      intervalMs,
    );
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return THINKING_PHRASES[index];
}

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE = /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: context chips are a positional, fixed-order list
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-card/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
        >
          {chipIcon(c)}
          <span className="font-medium text-foreground">{chipLabel(c)}</span>
          {"lines" in c && c.lines > 0 ? (
            <span className="opacity-70">· {c.lines}L</span>
          ) : null}
        </span>
      ))}
    </div>
  );
});

function chipIcon(c: ContextChip) {
  if (c.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={c.source === "editor" ? CodeIcon : TerminalIcon}
        size={10}
        strokeWidth={1.75}
      />
    );
  }
  if (c.kind === "file") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  if (c.kind === "file") return c.name;
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type ApprovalArg = {
  id: string;
  approved: boolean;
  reason?: string;
};

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  addToolApprovalResponse: (arg: ApprovalArg) => void | PromiseLike<void>;
  stop: () => void | PromiseLike<void>;
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
}: Props) {
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const showSpinner = isBusy && lastMessage?.role === "user";
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  const step = useChatStore((s) => s.agentMeta.step);
  const stopReason = useChatStore((s) => s.agentMeta.stopReason);
  const runRound = useChatStore((s) => s.agentMeta.runRound);
  // BatikCode-style rotating "working" phrase while the model is thinking.
  const thinkingPhrase = useRotatingPhrase(isBusy && !step);
  const compactionNotice = useChatStore((s) => s.agentMeta.compactionNotice);
  const memoryNotice = useChatStore((s) => s.agentMeta.memoryNotice);
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);
  const stoppedByUser = useChatStore((s) => s.agentMeta.stoppedByUser);
  const showReasoning = usePreferencesStore((s) => s.showReasoning);
  // Offer to resume after a stop as well as after the step cap. A stop used to
  // be a dead end: the only way on was to retype the request.
  // "steered" is not a dead end to offer Continue for: the run yielded to a
  // queued task that flushSteer sends immediately, so no resume prompt is shown.
  const showContinue =
    !isBusy &&
    ((stopReason !== null && stopReason !== "steered") || stoppedByUser) &&
    lastMessage?.role === "assistant";
  // A stop the user asked for is described as their own, whatever guard the
  // loop happened to trip on the way out.
  const continueKind: StopKind =
    stoppedByUser || stopReason === "steered"
      ? "stopped"
      : (stopReason ?? "step-cap");

  const onApproval = useCallback(
    (id: string, approved: boolean) =>
      addToolApprovalResponse({ id, approved }),
    [addToolApprovalResponse],
  );

  // Answer the prompts the current approval mode delegates. Runs after the
  // parts render, so an auto-approved call still appears in the transcript.
  useAutoApproval(messages, addToolApprovalResponse);

  if (messages.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            title="Ask Termigo anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation>
      <ConversationContent className="gap-5 p-3">
        {messages.map((m) => (
          <RenderedMessage
            key={m.id}
            message={m}
            onApproval={onApproval}
            streaming={m.id === streamingMessageId}
            showReasoning={showReasoning}
          />
        ))}
        {compactionNotice && (
          <CompactionNotice
            droppedCount={compactionNotice.droppedCount}
            onDismiss={() => patchAgentMeta({ compactionNotice: null })}
          />
        )}
        {memoryNotice && (
          <MemoryNotice
            fact={memoryNotice.fact}
            onDismiss={() => patchAgentMeta({ memoryNotice: null })}
          />
        )}
        <ElicitationCarousel />
        <ConfirmationCarousel />
        {showSpinner && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span className="truncate">{step ?? `${thinkingPhrase}…`}</span>
          </div>
        )}
        {isBusy && <TrajectoryThinkingHUD />}
        {showContinue && (
          <ContinueRow
            kind={continueKind}
            round={runRound}
            onContinue={() => {
              patchAgentMeta({ stopReason: null, stoppedByUser: false });
              void resumeRun();
            }}
          />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Request failed.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {humanizeModelError(error.message)}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {/* Retry re-runs the turn. After a context overflow the model's
                  real window has been learned, so this compacts harder and the
                  retry actually fits — the "Try again" the user expects. */}
              <button
                type="button"
                onClick={() => {
                  clearError();
                  patchAgentMeta({ stopReason: null, stoppedByUser: false });
                  void resumeRun();
                }}
                className="rounded bg-destructive/20 px-2 py-0.5 font-medium hover:bg-destructive/30"
              >
                Try again
              </button>
              {/* One-click undo to the last checkpoint when the run left the
                  tree in a bad state. Only renders when a checkpoint exists. */}
              <RollbackSuggestion />
              <button
                type="button"
                onClick={clearError}
                className="underline opacity-80 hover:opacity-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

/**
 * Say what the agent just wrote to project memory.
 *
 * A remembered fact joins the system prompt of every later run, including in
 * sessions months from now, and in the permissive approval modes it is written
 * without a click. Four wrong ones once rode in that way and steered every
 * reply until the file was opened by hand. This is the moment to catch that,
 * and `.termigo/memory.md` is where to remove it.
 */
const MemoryNotice = memo(function MemoryNotice({
  fact,
  onDismiss,
}: {
  fact: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-sky-500/80" />
      <span className="flex-1">
        <span className="font-medium text-foreground/80">Remembered</span>
        {" — "}
        {fact}
        <span className="mt-0.5 block opacity-70">
          Kept in .termigo/memory.md and added to every later run. Edit or
          delete it there.
        </span>
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-[10.5px] underline opacity-70 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

const CompactionNotice = memo(function CompactionNotice({
  droppedCount,
  onDismiss,
}: {
  droppedCount: number;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500/80" />
      <span className="flex-1 truncate">
        Context compacted — {droppedCount} older tool result
        {droppedCount === 1 ? "" : "s"} elided to save tokens.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline opacity-70 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

type StopKind = AgentStopReason | "stopped";

/**
 * What each stop means, and whether another round is likely to help.
 *
 * The row used to read "Hit the step limit" for every early stop, including
 * one the user asked for. Naming the cause is the point: running out of budget
 * invites a click, while a loop or an idle turn means the next round would
 * most likely repeat the last one.
 */
function stopCopy(
  kind: StopKind,
  round: number,
): { text: string; action: string; hint?: string } {
  const spent = stepBudgetForRound(round);
  const next = stepBudgetForRound(round + 1);
  // Only worth saying when the ladder actually climbs; the top tier repeats.
  const deeper = next > spent ? ` (next round: ${next})` : "";
  switch (kind) {
    case "step-cap":
      return {
        text: `Paused after ${spent} steps — this round's budget.`,
        action: `Continue${deeper}`,
      };
    case "tool-repetition":
      return {
        text: "Stopped: the same tool ran three times with identical input.",
        hint: "Another round would likely repeat it. Adding a detail usually helps more.",
        action: "Continue anyway",
      };
    case "no-progress":
      return {
        text: "Stopped: two turns in a row made no tool call.",
        hint: "The agent was describing rather than doing. Say what to change.",
        action: "Continue anyway",
      };
    case "tool-error":
      return {
        text: "Stopped: three turns in a row, every tool call failed.",
        hint: "The agent kept hitting a failing tool. Check the command/path it was trying, then continue.",
        action: "Continue anyway",
      };
    case "cost-cap":
      return {
        text: "Stopped: reached the maximum cost budget for this run.",
        hint: "Adjust the cost budget in settings if you wish to allow higher spend.",
        action: "Continue anyway",
      };
    case "stopped":
    // A steered run yields to a queued task and never surfaces this row, but the
    // switch stays exhaustive.
    case "steered":
    // A user-pressed Stop aborts the step loop; surface the same "You stopped"
    // copy rather than an unrelated budget/loop explanation.
    case "aborted":
      return { text: "You stopped this run.", action: "Resume" };
    case "interrupted":
      return {
        text: "This run was interrupted — the app closed or the run was cut off.",
        hint: "Your progress is preserved. Resume to pick up where it stopped.",
        action: "Resume",
      };
  }
}

const ContinueRow = memo(function ContinueRow({
  kind,
  round,
  onContinue,
}: {
  kind: StopKind;
  round: number;
  onContinue: () => void;
}) {
  const copy = stopCopy(kind, round);
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/50 bg-card/60 px-2.5 py-1.5 text-[11px]">
      <span className="flex-1 text-muted-foreground">
        {copy.text}
        {copy.hint && (
          <span className="mt-0.5 block opacity-75">{copy.hint}</span>
        )}
      </span>
      <button
        type="button"
        onClick={onContinue}
        className="shrink-0 rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
      >
        {copy.action}
      </button>
    </div>
  );
});

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
  streaming,
  showReasoning,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  showReasoning: boolean;
}) {
  // Index of the trailing text part — only that one is "live" mid-stream.
  // Earlier text parts (separated by tool calls) are already finalized.
  let lastTextIdx = -1;
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    if (message.parts[i]?.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  // Hoisted above the user branch so the hook always runs, whatever the role.
  // The user branch returns early, and a hook after a conditional return
  // violates the Rules of Hooks (React would throw if the role ever changed).
  const groups = useMemo(
    () => buildPartGroups(message.parts as AnyPart[]),
    [message.parts],
  );
  const focusInput = useChatStore((s) => s.focusInput);
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const cmdMatch = rawText.match(TERMIGO_CMD_RE);
    const commandName = cmdMatch?.[1] ?? null;
    const withoutCmd = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;
    const stripped = stripUserContextBlocks(withoutCmd);

    return (
      <Message from="user">
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {stripped.chips.length > 0 ? (
            <ContextChips chips={stripped.chips} />
          ) : null}
          {stripped.text ? (
            <p className="whitespace-pre-wrap wrap-break-word">
              {stripped.text}
            </p>
          ) : null}
        </MessageContent>
        {rawText.trim() ? (
          <MessageActions>
            <MessageAction
              tooltip="Edit and resend"
              label="Edit message"
              onClick={() => focusInput(rawText)}
            >
              <HugeiconsIcon icon={Edit02Icon} size={13} strokeWidth={1.75} />
            </MessageAction>
          </MessageActions>
        ) : null}
      </Message>
    );
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-3">
          {groups.map((g, gi) => {
            if (g.kind === "reasoning") {
              // The reasoning is "live" while the message is still streaming and
              // this reasoning block is the last thing emitted — that is when the
              // model is thinking. Passing isStreaming auto-opens it so the user
              // watches the thinking unfold, then it collapses once (still
              // openable by clicking the header).
              const reasoningLive = streaming && gi === groups.length - 1;
              return showReasoning ? (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <Reasoning
                    isStreaming={reasoningLive}
                    showReasoning={showReasoning}
                  >
                    <ReasoningTrigger />
                    <ReasoningContent>{g.text}</ReasoningContent>
                  </Reasoning>
                </PartAppear>
              ) : null;
            }
            if (g.kind === "reads") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadGroup parts={g.parts} />
                </PartAppear>
              );
            }
            const isReadSingle =
              partType(g.part) === "tool-read_file" &&
              ((g.part as { state?: string }).state ?? "") !==
                "approval-requested";
            if (isReadSingle) {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadRow part={g.part} />
                </PartAppear>
              );
            }
            return (
              <PartAppear key={`${message.id}-${g.key}`}>
                <RenderedPart
                  part={g.part}
                  onApproval={onApproval}
                  streaming={streaming && g.idx === lastTextIdx}
                  showReasoning={showReasoning}
                />
              </PartAppear>
            );
          })}
        </div>
      </MessageContent>
    </Message>
  );
});

type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string }
  | { kind: "reasoning"; text: string; key: string };

function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    const { parts: runParts, startIdx } = run;
    if (runParts.length >= 2) {
      out.push({
        kind: "reads",
        parts: runParts,
        key: `reads-${partKey(runParts[0], startIdx)}`,
      });
    } else {
      runParts.forEach((p, k) => {
        const idx = startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  // Every reasoning part in the message folds into one block, shown where the
  // first one appeared. A multi-step run emits one per step, so a five-step
  // task stacked five "Reasoned for 2s" labels down the transcript and buried
  // the work between them. One label for the whole run reads the way VS Code's
  // does; the thinking itself is all still there, in order, inside it.
  let reasoning: { text: string[]; key: string } | null = null;

  parts.forEach((p, i) => {
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    if (partType(p) === "reasoning") {
      const text = (p as unknown as { text?: string }).text ?? "";
      if (!reasoning) {
        reasoning = { text: [], key: `reasoning-${partKey(p, i)}` };
        // Placeholder in position; its text is filled in as later parts arrive.
        out.push({ kind: "reasoning", text: "", key: reasoning.key });
      }
      if (text) reasoning.text.push(text);
      return;
    }
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();

  if (reasoning) {
    const merged = reasoning as { text: string[]; key: string };
    const slot = out.findIndex(
      (g) => g.kind === "reasoning" && g.key === merged.key,
    );
    if (slot !== -1) {
      out[slot] = {
        kind: "reasoning",
        // Blank line between steps: it is several passes of thinking, not one
        // paragraph, and running them together reads as a non sequitur.
        text: merged.text.join("\n\n"),
        key: merged.key,
      };
    }
  }
  return out;
}

function readPathFromPart(p: AnyPart): string | null {
  const input = (p as { input?: { path?: unknown } }).input;
  const path = input?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const ReadGroup = memo(function ReadGroup({ parts }: { parts: AnyPart[] }) {
  const paths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const path = readPathFromPart(p);
      if (!path) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [parts]);
  const count = paths.length || parts.length;
  const preview = paths.map(basename).join(", ");

  return (
    <Collapsible className="group/read overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/read:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <Shimmer
          as="span"
          duration={1.4}
          iterations={2}
          className="shrink-0 font-medium text-foreground"
        >
          Read
        </Shimmer>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} file{count === 1 ? "" : "s"}
        </span>
        {paths.length > 0 ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 group-data-[state=open]/read:invisible">
            · {preview}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="termigo-collapsible-content border-t border-border/30">
        <ul className="flex flex-col gap-0.5 px-2 py-1.5">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            >
              <HugeiconsIcon
                icon={File01Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 opacity-60"
              />
              <span className="truncate text-foreground">{basename(path)}</span>
              <span className="truncate opacity-60">{path}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});

const PartAppear = memo(function PartAppear({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out">
      {children}
    </div>
  );
});

const ReadRow = memo(function ReadRow({ part }: { part: AnyPart }) {
  const path = readPathFromPart(part);
  const state = (part as { state?: string }).state ?? "";
  const isError = state === "output-error";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError
            ? "bg-destructive"
            : "border border-muted-foreground/40 bg-transparent",
        )}
      />
      <HugeiconsIcon
        icon={File01Icon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <Shimmer
        as="span"
        duration={
          state === "input-streaming" || state === "input-available" ? 1 : 1.4
        }
        iterations={
          state === "input-streaming" || state === "input-available"
            ? "infinite"
            : 2
        }
        className="shrink-0 font-medium text-foreground"
      >
        Read
      </Shimmer>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {path ?? ""}
      </span>
    </div>
  );
});

const aiStreamdownComponents = {
  a: (props: MarkdownLinkProps) => (
    <MarkdownLink {...props} onSettled={useChatStore.getState().focusInput} />
  ),
  code: MarkdownCode,
};

function AiMessageResponse(props: Omit<MessageResponseProps, "components">) {
  return <MessageResponse {...props} components={aiStreamdownComponents} />;
}

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
  streaming,
  showReasoning,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  showReasoning: boolean;
}) {
  if (part.type === "text") {
    return (
      <AiMessageResponse streaming={streaming}>
        {(part as unknown as { text: string }).text}
      </AiMessageResponse>
    );
  }

  if (part.type === "reasoning") {
    return showReasoning ? (
      <Reasoning showReasoning={showReasoning}>
        <ReasoningTrigger />
        <ReasoningContent>
          {(part as unknown as { text: string }).text}
        </ReasoningContent>
      </Reasoning>
    ) : null;
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    return (
      <RenderedTool
        part={part as unknown as AnyToolPart}
        onApproval={onApproval}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean) => void;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  if (part.state === "approval-requested") {
    return (
      <AiToolApproval
        part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
        toolName={toolName}
        onRespond={(approved) => onApproval(part.approval.id, approved)}
      />
    );
  }

  return (
    <Tool
      toolName={toolName}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
      defaultOpen={toolName === "list_directory"}
    />
  );
});
