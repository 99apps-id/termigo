// Live progress streaming for Telegram.
//
// Holds the per-message AbortController map so the polling loop can cancel
// stale intermediate edits when a new round starts, plus the helper that
// actually builds and pushes the markdown-bubbled progress message.

import {
  sendProgressMessage,
  editProgressMessage,
  sendKeyboard,
  sendTyping,
  type InlineButton,
} from "./telegramApi";
import { getPendingApprovals, runBusy } from "./telegramHelpers";

export const progressCtrls = new Map<number, AbortController>();
export const lastFinishedProgressMessageIds = new Map<number, number>();
export const sentApprovalIds = new Set<string>();

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Publish a live progress bubble for `chatId` on Telegram. */
export async function publishProgress(
  chatId: number,
  sessionId: string,
  signal: AbortSignal,
  initialText?: string,
  mode: "task" | "question" = "task",
): Promise<void> {
  const store = await import("../ai/store/chatStore");
  const todosStore = await import("../ai/store/todoStore");
  const { extractToolSummaries, formatLiveProgress, resolveModelLabel } =
    await import("./progressFormat");
  let progressMessageId: number | null = null;
  let lastLiveText = "";
  let lastSentAt = 0;
  let lastTypingAt = 0;
  let lastLiveTextPokeAt = 0;
  const sentElicitationIds = new Set<string>();
  const started = Date.now();
  const MAX_WAIT = 30 * 60 * 1000;
  // Tracks step-cap detection to avoid sending the Continue button twice
  let stepCapNotified = false;

  if (mode === "question") {
    return;
  }

  if (initialText) {
    progressMessageId = await sendProgressMessage(chatId, initialText, signal);
    lastLiveText = initialText;
    lastSentAt = Date.now();
    lastTypingAt = Date.now();
    await sendTyping(chatId, signal).catch(() => {});
  }

  try {
    while (!signal.aborted && Date.now() - started < MAX_WAIT) {
      const meta = store.useChatStore.getState().agentMeta;
      const status = meta.status;
      const step = meta.step ?? "";
      const todos =
        todosStore.useTodosStore.getState().bySession[sessionId]?.items ?? [];
      const now = Date.now();

      // Keep the "typing..." bubble alive while the run is busy (thinking,
      // streaming, or awaiting approval).
      const chat = store.getChat(sessionId);
      const chatStatus = chat?.status ?? "";
      const aqStore = await import("../ai/store/approvalQueueStore");
      const pendingApprovals = getPendingApprovals(sessionId, store, aqStore);
      const busy =
        runBusy(chatStatus, status, pendingApprovals.length > 0) ||
        status === "thinking" ||
        status === "streaming" ||
        status === "awaiting-approval" ||
        progressMessageId === null;

      if (busy && now - lastTypingAt >= 3000) {
        lastTypingAt = now;
        await sendTyping(chatId, signal).catch(() => {});
      }

      // Collect tool parts from the active assistant message
      const messages = chat?.messages ?? [];
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const toolSummaries = lastAssistant?.parts
        ? extractToolSummaries(lastAssistant.parts)
        : [];

      // Format compact live progress
      const liveStatus =
        pendingApprovals.length > 0
          ? "awaiting-approval"
          : status === "idle" && busy
            ? "thinking"
            : status;
      const liveText = formatLiveProgress({
        status: liveStatus,
        round: meta.round,
        step,
        tools: toolSummaries,
        todos,
        elapsedMs: now - started,
        mode,
        modelLabel: await resolveModelLabel(
          store.useChatStore.getState().selectedModelId,
        ),
      });

      if (!progressMessageId) {
        progressMessageId = await sendProgressMessage(chatId, liveText, signal);
        lastLiveText = liveText;
        lastSentAt = now;
        lastTypingAt = now;
        // Telegram client clears typing indicator when a message is received; re-send typing immediately.
        await sendTyping(chatId, signal).catch(() => {});
      } else if (liveText !== lastLiveText && now - lastSentAt >= 1500) {
        lastLiveText = liveText;
        await editProgressMessage(chatId, progressMessageId, liveText, signal);
        lastSentAt = now;
      } else if (
        busy &&
        now - lastLiveTextPokeAt >= 5000
      ) {
        lastLiveTextPokeAt = now;
        await sendTyping(chatId, signal).catch(() => {});
        await editProgressMessage(
          chatId,
          progressMessageId,
          liveText,
          signal,
        ).catch(() => {});
      }

      // Surface pending approvals as interactive inline buttons in Telegram
      for (const p of pendingApprovals) {
        if (!sentApprovalIds.has(p.id)) {
          sentApprovalIds.add(p.id);
          const prefix = p.source === "queue" ? "aq" : "ap";
          const keyboard: InlineButton[][] = [
            [
              { text: "Approve", callback_data: `${prefix}:approve:${p.id}` },
              { text: "Deny", callback_data: `${prefix}:deny:${p.id}` },
            ],
            [
              {
                text: "Allow session",
                callback_data: `${prefix}:session:${p.id}`,
              },
              {
                text: "Allow always",
                callback_data: `${prefix}:always:${p.id}`,
              },
            ],
          ];
          await sendKeyboard(
            chatId,
            `Action Approval Required:\nTool: ${p.toolName}\nTarget: ${p.summary || p.toolName}\n(Reply /approve or /deny)`,
            keyboard,
            signal,
          ).catch(() => {});
          lastSentAt = now;
        }
      }

      // Surface questions from ask_user (elicitation)
      const elStore = await import("../ai/store/elicitationStore");
      const elPending = elStore.useElicitationStore.getState().pending;
      for (const el of elPending) {
        if (!sentElicitationIds.has(el.id)) {
          sentElicitationIds.add(el.id);
          const keyboard: InlineButton[][] = el.options
            .slice(0, 6)
            .map((opt, i) => [
              { text: opt.slice(0, 40), callback_data: `el:${el.id}:${i}` },
            ]);
          await sendKeyboard(
            chatId,
            `Agent Question:\n${el.question}`,
            keyboard,
            signal,
          ).catch(() => {});
          lastSentAt = now;
        }
      }

      if (!busy && !stepCapNotified) {
        const latestMeta = store.useChatStore.getState().agentMeta;
        if (
          latestMeta.status === "idle" &&
          latestMeta.stopReason === "step-cap" &&
          !latestMeta.stoppedByUser
        ) {
          await sleep(signal, 1500);
          if (signal.aborted) break;
          const afterWait = store.useChatStore.getState().agentMeta;
          if (
            afterWait.status === "idle" &&
            afterWait.stopReason === "step-cap"
          ) {
            stepCapNotified = true;
            const { stepBudgetForRound } = await import("../ai/config");
            const nextBudget = stepBudgetForRound(
              (afterWait.runRound ?? 0) + 1,
            );
            await sendKeyboard(
              chatId,
              `Step limit reached (round ${afterWait.runRound ?? 1}). Continue to next round (${nextBudget} steps)?`,
              [
                [
                  {
                    text: `>> Continue (${nextBudget} steps)`,
                    callback_data: "resume:run",
                  },
                ],
              ],
              signal,
            ).catch(() => {});
            break;
          }
          stepCapNotified = false;
        }
      }

      await sleep(signal, 1000);
    }
  } finally {
    if (progressMessageId) {
      const doneText = formatLiveProgress({ status: "idle", completed: true });
      await editProgressMessage(
        chatId,
        progressMessageId,
        doneText,
        AbortSignal.timeout(4000),
      ).catch(() => {});
      lastFinishedProgressMessageIds.set(chatId, progressMessageId);
    }
  }
}
