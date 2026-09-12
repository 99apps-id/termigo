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
  chatStore?: any,
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
    parts?: Array<{ type?: string; text?: string; [k: string]: any }>;
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
  const last = relevant[relevant.length - 1];
  const text = (last.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return text.trim() || null;
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
