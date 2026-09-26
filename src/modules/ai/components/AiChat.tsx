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
import { Tool } from "@/components/ai-elements/tool";
import { Spinner } from "@/components/ui/spinner";
import { SubagentBatchCard } from "@/modules/ai/components/SubagentBatchCard";
import { ToolDiffCard } from "@/modules/ai/components/ToolDiffCard";
import {
  MarkdownLink,
  type MarkdownLinkProps,
} from "@/modules/markdown/MarkdownLink";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { toast } from "@/components/ui/toast";
import {
  ArrowTurnBackwardIcon,
  Edit02Icon,
  ForkIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useAutoApproval } from "../hooks/useAutoApproval";
import { humanizeModelError } from "../lib/errorMessage";
import { isContentFilterError } from "../lib/errors";
import { TERMIGO_CMD_RE } from "../lib/slashCommands";
import {
  beginEditUserMessage,
  resumeRun,
  rewindToTurn,
} from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
import { useTurnCheckpointStore } from "../store/turnCheckpointStore";
import { AiToolApproval } from "./AiToolApproval";
import {
  CommandSnippet,
  ContextChips,
  stripUserContextBlocks,
} from "./ChatContextChips";
import {
  CompactionNotice,
  ContinueRow,
  MemoryNotice,
  PruneNotice,
  SideQuestionNotice,
  type StopKind,
} from "./ChatNotices";
import { PartAppear, ReadGroup, ReadRow } from "./ChatReadGroup";
import { ConfirmationCarousel } from "./ConfirmationCarousel";
import { type AnyPart, buildPartGroups, isThinkingLive, lastReasoningGroupIndex, partType } from "./chatPartGrouping";
import { ElicitationCarousel } from "./ElicitationCarousel";
import { ChatTimelineNavigator } from "./ChatTimelineNavigator";
import { RollbackSuggestion } from "./RollbackSuggestion";
import { RunProgressHUD } from "./RunProgressHUD";
import { TrajectoryThinkingHUD } from "./TrajectoryThinkingHUD";

/**
 * Rotating "working" phrases, in the style of VS Code's chat thinking part
 * (`chatThinkingContentPart`) - a calm status word that cycles while the model
 * is thinking (no tool step active yet) instead of a static "Thinking...". No
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

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

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
  const sessionId = useChatStore((s) => s.activeSessionId);
  const step = useChatStore((s) => s.agentMeta.step);
  const stopReason = useChatStore((s) => s.agentMeta.stopReason);
  const runRound = useChatStore((s) => s.agentMeta.runRound);
  // BatikCode-style rotating "working" phrase while the model is thinking.
  const thinkingPhrase = useRotatingPhrase(isBusy && !step);
  const compactionNotice = useChatStore((s) => s.agentMeta.compactionNotice);
  const pruneNotice = useChatStore((s) => s.agentMeta.pruneNotice);
  const memoryNotice = useChatStore((s) => s.agentMeta.memoryNotice);
  const sideQuestion = useChatStore((s) => s.agentMeta.sideQuestion);
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);
  const stoppedByUser = useChatStore((s) => s.agentMeta.stoppedByUser);
  const showReasoning = usePreferencesStore((s) => s.showReasoning);
  const agentMetaError = useChatStore((s) => s.agentMeta.error);
  const activeErrorMessage = error?.message ?? agentMetaError;
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

  const respondToApproval = useChatStore((s) => s.respondToApproval);
  const onApproval = useCallback(
    (id: string, approved: boolean) => {
      respondToApproval(id, approved);
      if (!useChatStore.getState().approvalResponder) {
        addToolApprovalResponse({ id, approved });
      }
    },
    [respondToApproval, addToolApprovalResponse],
  );

  // Answer the prompts the current approval mode delegates. Runs after the
  // parts render, so an auto-approved call still appears in the transcript.
  const handleAutoApproval = useCallback(
    ({ id, approved }: { id: string; approved: boolean }) => {
      respondToApproval(id, approved);
      if (!useChatStore.getState().approvalResponder) {
        addToolApprovalResponse({ id, approved });
      }
    },
    [respondToApproval, addToolApprovalResponse],
  );
  useAutoApproval(messages, handleAutoApproval);

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
      <ChatTimelineNavigator messages={messages} sessionId={sessionId} />
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
        {pruneNotice && (
          <PruneNotice
            prunedMessages={pruneNotice.prunedMessages}
            onDismiss={() => patchAgentMeta({ pruneNotice: null })}
          />
        )}
        {memoryNotice && (
          <MemoryNotice
            fact={memoryNotice.fact}
            onDismiss={() => patchAgentMeta({ memoryNotice: null })}
          />
        )}
        {sideQuestion && (
          <SideQuestionNotice
            question={sideQuestion.question}
            answer={sideQuestion.answer}
            onDismiss={() => patchAgentMeta({ sideQuestion: null })}
          />
        )}
        <ElicitationCarousel />
        <ConfirmationCarousel />
        <RunProgressHUD />
        {showSpinner && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span className="truncate">{step ?? `${thinkingPhrase}...`}</span>
          </div>
        )}
        {isBusy && <TrajectoryThinkingHUD />}
        {showContinue && (
          <ContinueRow
            kind={continueKind}
            round={runRound}
            onContinue={() => {
              clearError();
              patchAgentMeta({ error: null, stopReason: null, stoppedByUser: false });
              void resumeRun();
            }}
          />
        )}
        {activeErrorMessage && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Request failed.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {error ? humanizeModelError(error.message) : activeErrorMessage}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {/* Retry re-runs the turn. After a context overflow the model's
                  real window has been learned, so this compacts harder and the
                  retry actually fits - the "Try again" the user expects. */}
              <button
                type="button"
                onClick={() => {
                  clearError();
                  patchAgentMeta({ error: null, stopReason: null, stoppedByUser: false });
                  void resumeRun();
                }}
                className="rounded bg-destructive/20 px-2 py-0.5 font-medium hover:bg-destructive/30"
              >
                Try again
              </button>
              {/* A content-moderation rejection replays the same flagged
                  history, so "Try again" can never clear it. The one action
                  that does is a fresh chat (empty history) - offer it only
                  for that error class, where retry is provably futile. */}
              {error && isContentFilterError(error.message) ? (
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    patchAgentMeta({ error: null });
                    useChatStore.getState().newSession();
                  }}
                  className="rounded bg-destructive/20 px-2 py-0.5 font-medium hover:bg-destructive/30"
                >
                  Start a new chat
                </button>
              ) : null}
              {/* One-click undo to the last checkpoint when the run left the
                  tree in a bad state. Only renders when a checkpoint exists. */}
              <RollbackSuggestion />
              <button
                type="button"
                onClick={() => {
                  clearError();
                  patchAgentMeta({ error: null });
                }}
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
  // Index of the trailing text part - only that one is "live" mid-stream.
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
  // Only the block the model is writing into right now opens on its own. What
  // identifies it is that the NEWEST PART is reasoning - not its position among
  // the groups, which is what the previous rule used and which never held in a
  // tool-using run (a tool card always trails the thinking).
  const thinkingLive = isThinkingLive(message.parts as AnyPart[], streaming);
  const liveReasoningIdx = useMemo(
    () => lastReasoningGroupIndex(groups),
    [groups],
  );
  const focusInput = useChatStore((s) => s.focusInput);
  const sessionId = useChatStore((s) => s.activeSessionId);
  // Rewind is offered only on turns that actually have a pre-run snapshot.
  const hasTurnCheckpoint = useTurnCheckpointStore((s) =>
    Boolean(
      sessionId &&
        s.bySession[sessionId]?.some((r) => r.messageId === message.id),
    ),
  );

  const hasTextPart = useMemo(
    () =>
      message.parts.some(
        (p) =>
          p.type === "text" &&
          typeof (p as { text?: unknown }).text === "string" &&
          (p as { text: string }).text.trim().length > 0,
      ),
    [message.parts],
  );

  const hasAnyToolParts = useMemo(
    () =>
      message.parts.some(
        (p) =>
          p.type === "dynamic-tool" ||
          (typeof p.type === "string" && p.type.startsWith("tool-")),
      ),
    [message.parts],
  );

  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const fileParts = message.parts.filter(
      (
        p,
      ): p is {
        type: "file";
        mediaType: string;
        url: string;
        filename?: string;
      } => p.type === "file",
    );

    const cmdMatch = rawText.match(TERMIGO_CMD_RE);
    const commandName = cmdMatch?.[1] ?? null;
    const withoutCmd = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;
    const stripped = stripUserContextBlocks(withoutCmd);

    // Edit-and-resend: prefill the composer AND arm pendingEditTarget, so
    // submitting truncates the transcript from this turn instead of stacking
    // a correction on top of a run that already went the wrong way.
    const onEdit = () => {
      if (beginEditUserMessage(message.id)) focusInput(rawText);
    };
    const onRewind = async () => {
      const ok = window.confirm(
        "Rewind to before this turn?\n\n" +
          "The working tree rolls back to the snapshot taken before this turn ran " +
          "(your current changes are checkpointed first, so the rollback itself is " +
          "undoable from git), and this message plus everything after it is removed " +
          "from the chat.",
      );
      if (!ok || !sessionId) return;
      const res = await rewindToTurn(sessionId, message.id);
      if (res.ok) {
        toast("Rewound files and chat to before this turn", {
          variant: "success",
        });
      } else {
        toast(res.error, { variant: "error" });
      }
    };
    const onFork = () => {
      const id = useChatStore.getState().forkSession(message.id);
      if (id) {
        toast("Forked a new session from this message", { variant: "success" });
      }
    };

    return (
      <Message
        from="user"
        id={`msg-${message.id}`}
        data-message-id={message.id}
      >
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {stripped.chips.length > 0 ? (
            <ContextChips chips={stripped.chips} />
          ) : null}
          {fileParts.length > 0 ? (
            <div className="my-1.5 flex flex-wrap gap-2">
              {fileParts.map((f, i) => {
                const isImage =
                  Boolean(f.mediaType?.startsWith("image/")) ||
                  f.url.startsWith("data:image/") ||
                  /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(f.filename ?? "");
                if (isImage) {
                  return (
                    <a
                      // biome-ignore lint/suspicious/noArrayIndexKey: attachments are ordered positionally
                      key={`${f.filename ?? "img"}-${i}`}
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative block overflow-hidden rounded-lg border border-border/70 bg-card shadow-2xs transition-transform hover:scale-[1.01]"
                    >
                      <img
                        src={f.url}
                        alt={f.filename ?? "Attached image"}
                        className="max-h-56 max-w-xs rounded-lg object-contain"
                      />
                      {f.filename && (
                        <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent p-1 px-1.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                          {f.filename}
                        </div>
                      )}
                    </a>
                  );
                }
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: attachments are ordered positionally
                    key={`${f.filename ?? "file"}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-card px-2 py-1 text-[11px] shadow-2xs"
                  >
                    <span className="font-mono text-[9.5px] font-semibold text-primary">
                      {f.filename
                        ?.slice(f.filename.lastIndexOf(".") + 1)
                        .toUpperCase() || "FILE"}
                    </span>
                    <span className="max-w-[14rem] truncate font-medium text-foreground">
                      {f.filename ?? "Document"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {stripped.text ? (
            <p className="whitespace-pre-wrap wrap-break-word">
              {stripped.text}
            </p>
          ) : null}
        </MessageContent>
        <MessageActions>
          {rawText.trim() ? (
            <MessageAction
              tooltip="Edit and resend — replaces this turn and everything after it"
              label="Edit message"
              onClick={onEdit}
            >
              <HugeiconsIcon icon={Edit02Icon} size={13} strokeWidth={1.75} />
            </MessageAction>
          ) : null}
          {hasTurnCheckpoint ? (
            <MessageAction
              tooltip="Rewind files and chat to before this turn"
              label="Rewind to here"
              onClick={() => void onRewind()}
            >
              <HugeiconsIcon
                icon={ArrowTurnBackwardIcon}
                size={13}
                strokeWidth={1.75}
              />
            </MessageAction>
          ) : null}
          <MessageAction
            tooltip="Fork a new session branching from this message"
            label="Fork from here"
            onClick={onFork}
          >
            <HugeiconsIcon icon={ForkIcon} size={13} strokeWidth={1.75} />
          </MessageAction>
        </MessageActions>
      </Message>
    );
  }

  return (
    <Message
      from={message.role}
      id={`msg-${message.id}`}
      data-message-id={message.id}
    >
      <MessageContent>
        <div className="flex flex-col gap-3">
          {groups.map((g, gi) => {
            if (g.kind === "reasoning") {
              // "Live" means the model is writing into THIS block right now, so
              // passing isStreaming auto-opens it and the user watches the
              // thinking unfold. It stays open once finished, so the transcript reads
              // thinking, reasoned, work, answer per step - and collapses by clicking
              //
              // the header. The finished "Reasoned" label keeps a long run scannable
              // without losing the thinking behind each step.
              const reasoningLive = thinkingLive && gi === liveReasoningIdx;
              return showReasoning ? (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <Reasoning
                    isStreaming={reasoningLive}
                    showReasoning={showReasoning}
                    autoClose={false}
                    defaultOpen
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
          {!hasTextPart && !streaming && !hasAnyToolParts && !showReasoning ? (
            <p className="text-xs text-muted-foreground italic">
              (Model completed with reasoning output only. You can enable reasoning visibility in chat settings to inspect details.)
            </p>
          ) : null}
        </div>
      </MessageContent>
      {!streaming ? (
        <MessageActions>
          <MessageAction
            tooltip="Fork a new session branching from this message"
            label="Fork from here"
            onClick={() => {
              const id = useChatStore.getState().forkSession(message.id);
              if (id) {
                toast("Forked a new session from this message", {
                  variant: "success",
                });
              }
            }}
          >
            <HugeiconsIcon icon={ForkIcon} size={13} strokeWidth={1.75} />
          </MessageAction>
        </MessageActions>
      ) : null}
    </Message>
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
      <Reasoning showReasoning={showReasoning} defaultOpen>
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
        onRespond={(approved, editedCommand) => {
          if (
            approved &&
            editedCommand !== undefined &&
            typeof part.input === "object" &&
            part.input !== null
          ) {
            try {
              (part.input as Record<string, unknown>).command = editedCommand;
            } catch {
              part.input = {
                ...(part.input as Record<string, unknown>),
                command: editedCommand,
              };
            }
          }
          onApproval(part.approval.id, approved);
        }}
      />
    );
  }

  if (
    toolName === "edit" ||
    toolName === "multi_edit" ||
    toolName === "write_file"
  ) {
    return <ToolDiffCard toolName={toolName} part={part} />;
  }

  if (toolName === "run_subagents" || toolName === "run_subagent") {
    return <SubagentBatchCard toolName={toolName} part={part} />;
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
