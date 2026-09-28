// Small shared utilities used across the Telegram relay layers:
// - approval discovery
// - busy-detection
// - message text extraction
// - assistant-message counting / slicing

export type PendingApprovalInfo = {
  id: string;
  toolName: string;
  summary: string;
  source: "sdk" | "queue";
};

export function getPendingApprovals(
  sessionId: string,
  // biome-ignore lint/suspicious/noExplicitAny: callers pass either the real zustand store or a partial mock, so the shape is duck-typed at runtime
  chatStore?: any,
  // biome-ignore lint/suspicious/noExplicitAny: callers pass either the real zustand store or a partial mock, so the shape is duck-typed at runtime
  aqStore?: any,
): PendingApprovalInfo[] {
  const result: PendingApprovalInfo[] = [];
  const seen = new Set<string>();

  // 1. Direct scan from active Chat instance
  if (chatStore && sessionId) {
    const chatGetter =
      typeof chatStore.getChat === "function" ? chatStore.getChat : null;
    const chat = chatGetter ? chatGetter(sessionId) : null;
    if (chat) {
      for (const m of chat.messages) {
        if (m.role !== "assistant") continue;
        for (const p of m.parts ?? []) {
          const part = p as {
            state?: string;
            type?: string;
            toolName?: string;
            input?: unknown;
            approval?: { id?: string };
            approvalId?: string;
            id?: string;
          };
          if (part.state === "approval-requested") {
            const id = part.approval?.id || part.approvalId || part.id;
            if (id && !seen.has(id)) {
              seen.add(id);
              const toolName =
                typeof part.toolName === "string" && part.toolName
                  ? part.toolName
                  : (part.type ?? "").replace(/^tool-/, "") || "tool";
              const summary = summarizeToolInput(toolName, part.input);
              result.push({ id, toolName, summary, source: "sdk" });
            }
          }
        }
      }
    }

    // 2. ChatStore agentMeta.pendingApprovals (populated by AgentRunBridge)
    const chatState =
      typeof chatStore.getState === "function"
        ? chatStore.getState()
        : chatStore.useChatStore?.getState?.();
    const metaPending = chatState?.agentMeta?.pendingApprovals ?? [];
    for (const p of metaPending) {
      if (p.id && !seen.has(p.id)) {
        seen.add(p.id);
        result.push({
          id: p.id,
          toolName: p.toolName,
          summary: p.summary,
          source: "sdk",
        });
      }
    }
  }

  // 3. Approval queue store
  if (aqStore) {
    const queueState =
      typeof aqStore.getState === "function"
        ? aqStore.getState()
        : aqStore.useApprovalQueue?.getState?.();
    const queuePending = queueState?.pending ?? [];
    for (const q of queuePending) {
      if (q.id && !seen.has(q.id)) {
        seen.add(q.id);
        result.push({
          id: q.id,
          toolName: q.toolName,
          summary: q.summary,
          source: "queue",
        });
      }
    }
  }

  return result;
}

export type ChatLike = {
  messages: Array<{
    role: string;
    parts?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  }>;
};

/** Approximate busy state: thinking/streaming/awaiting-approval or pending approvals > 0 */
export function runBusy(
  chatStatus: string,
  appStatus: string,
  hasPendingApproval = false,
): boolean {
  return (
    hasPendingApproval ||
    chatStatus === "submitted" ||
    chatStatus === "streaming" ||
    appStatus === "thinking" ||
    appStatus === "streaming" ||
    appStatus === "awaiting-approval"
  );
}

/**
 * Whether the agent is actively writing/generating tokens or executing a tool.
 *
 * Distinct from runBusy: an agent in awaiting-approval or waiting for user confirmation
 * is NOT actively typing. Sending Telegram typing actions while waiting for confirmation
 * makes the user wait expecting text rather than reviewing and acting on the approval card.
 */
export function isActivelyTyping(
  chatStatus: string,
  appStatus: string,
  activeTools = false,
): boolean {
  if (
    appStatus === "awaiting-approval" ||
    appStatus === "idle" ||
    appStatus === "error"
  ) {
    return false;
  }
  return (
    chatStatus === "submitted" ||
    chatStatus === "streaming" ||
    appStatus === "thinking" ||
    appStatus === "streaming" ||
    activeTools
  );
}


/**
 * Tool states that mean the call has returned. `output-available` is the normal
 * success state, and the whole app treats it as finished - `AgentRunBridge`
 * answers this same question the same way.
 *
 * This was a two-entry deny-list (`output-error`, `error`) until now, so every
 * COMPLETED call still counted as active: the relay read the transcript, saw a
 * tool that had already returned, and called the session busy for the rest of
 * its life. That is the stuck state reported from the field - the agent idle in
 * the app while Telegram kept the typing indicator alive, answered each new
 * message with "The agent is busy", and never flushed the text it queued,
 * because the flush is gated on the same flag. `/stop` did not clear it either:
 * stopping settles the run, not the transcript. The previous patch to this list
 * added `output-error`, a FAILED tool, so it only ever fixed the rarer half.
 */
const FINISHED_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "result",
  // A tool pending approval is not actively running; the approval system
  // surfaces it separately. Without this, `hasActiveToolCalls` reported
  // busy for a session waiting on an approval the user had not yet seen.
  "approval-requested",
]);

export function hasActiveToolCalls(chat: ChatLike | null | undefined): boolean {
  if (!chat?.messages?.length) return false;
  // Only the most recent assistant message can have tool calls currently in flight.
  // Past turns never keep a session busy.
  const lastAssistant = [...chat.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!lastAssistant) return false;

  const parts = lastAssistant.parts ?? [];
  for (let j = parts.length - 1; j >= 0; j -= 1) {
    const part = parts[j] as
      | { type?: string; state?: string; output?: unknown }
      | undefined;
    const type = typeof part?.type === "string" ? part.type : "";
    if (
      !type.startsWith("tool-") &&
      type !== "tool-call" &&
      type !== "dynamic-tool"
    ) {
      continue;
    }
    const state = typeof part?.state === "string" ? part.state : "";
    if (FINISHED_TOOL_STATES.has(state) || part?.output !== undefined) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Interpret a free-text reply to a pending `ask_user` question.
 *
 * A bare number selects that option (Telegram shows them in order, so "2" is a
 * natural reply), and anything else is passed through verbatim - the question
 * is answered by a model, and a sentence like "not that one, do this instead"
 * is a better answer than being forced onto a button.
 */
export function matchElicitationAnswer(
  text: string,
  options: readonly string[],
): string {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (n >= 1 && n <= options.length) return options[n - 1];
  }
  return trimmed;
}

function summarizeToolInput(toolName: string, input?: unknown): string {
  if (!input) return toolName;
  if (typeof input === "string") {
    const s = input.trim();
    return s ? `${toolName}: ${s.slice(0, 100)}` : toolName;
  }
  if (typeof input === "object") {
    try {
      const json = JSON.stringify(input);
      return json ? `${toolName}: ${json.slice(0, 100)}` : toolName;
    } catch {
      return toolName;
    }
  }
  return toolName;
}

export function countAssistantMessages(
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
): number {
  const chat = getChat(sessionId);
  return chat ? chat.messages.filter((m) => m.role === "assistant").length : 0;
}

export function lastAssistantText(
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
  sinceCount: number,
): string | null {
  const chat = getChat(sessionId);
  if (!chat) return null;
  const assistants = chat.messages.filter((m) => m.role === "assistant");
  const relevant = assistants.slice(sinceCount);
  if (relevant.length === 0) return null;
  // Walk BACKWARDS and take the newest message that actually says something.
  //
  // Reading only the final message looked equivalent and was not: a run's last
  // assistant message very often ends on a tool call with no closing prose, so
  // its text parts are empty while the answer sits in the message before it.
  // Measured on a live install: 9 of 51 stored sessions ended that way, and the
  // relay answered each of them with a bare "Run finished." because the
  // extraction returned null. The user asked for an audit and got a status line.
  for (let i = relevant.length - 1; i >= 0; i -= 1) {
    const text = (relevant[i].parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

export function messageText(m: {
  role: string;
  parts?: Array<{ type?: string; text?: string }>;
}): string {
  const text = (m.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return text.trim();
}

/** Telegram caps a message at 4096 chars; chunking is preferred over lossy clamping. */
export function clampTelegramText(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}
