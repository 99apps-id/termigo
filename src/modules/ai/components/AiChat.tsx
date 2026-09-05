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
import {
  MarkdownLink,
  type MarkdownLinkProps,
} from "@/modules/markdown/MarkdownLink";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
} from "ai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useAutoApproval } from "../hooks/useAutoApproval";
import { humanizeModelError } from "../lib/errorMessage";
import { isContentFilterError } from "../lib/errors";
import { TERMIGO_CMD_RE } from "../lib/slashCommands";
import { resumeRun } from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
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
  type StopKind,
} from "./ChatNotices";
import { ConfirmationCarousel } from "./ConfirmationCarousel";
import { ElicitationCarousel } from "./ElicitationCarousel";
import { RollbackSuggestion } from "./RollbackSuggestion";
import { RunProgressHUD } from "./RunProgressHUD";
import { TrajectoryThinkingHUD } from "./TrajectoryThinkingHUD";
import { SubagentBatchCard } from "@/modules/ai/components/SubagentBatchCard";
import { ToolDiffCard } from "@/modules/ai/components/ToolDiffCard";
import {
  type AnyPart,
  buildPartGroups,
  partType,
} from "./chatPartGrouping";
import { PartAppear, ReadGroup, ReadRow } from "./ChatReadGroup";

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
  const step = useChatStore((s) => s.agentMeta.step);
  const stopReason = useChatStore((s) => s.agentMeta.stopReason);
  const runRound = useChatStore((s) => s.agentMeta.runRound);
  // BatikCode-style rotating "working" phrase while the model is thinking.
  const thinkingPhrase = useRotatingPhrase(isBusy && !step);
  const compactionNotice = useChatStore((s) => s.agentMeta.compactionNotice);
  const pruneNotice = useChatStore((s) => s.agentMeta.pruneNotice);
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
                  retry actually fits - the "Try again" the user expects. */}
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
              {/* A content-moderation rejection replays the same flagged
                  history, so "Try again" can never clear it. The one action
                  that does is a fresh chat (empty history) - offer it only
                  for that error class, where retry is provably futile. */}
              {isContentFilterError(error.message) ? (
                <button
                  type="button"
                  onClick={() => {
                    clearError();
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
              // this reasoning block is the last thing emitted - that is when the
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
