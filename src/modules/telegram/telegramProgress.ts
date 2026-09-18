// Live progress streaming for Telegram.
//
// Holds the per-message AbortController map so the polling loop can cancel
// stale intermediate edits when a new round starts, plus the helper that
// actually builds and pushes the markdown-bubbled progress message.

import {
  editProgressMessage,
  type InlineButton,
  sendKeyboard,
  sendProgressMessage,
  sendTyping,
} from "./telegramApi";
import {
  getPendingApprovals,
  hasActiveToolCalls,
  messageText,
  runBusy,
} from "./telegramHelpers";

export const progressCtrls = new Map<number, AbortController>();
export const lastFinishedProgressMessageIds = new Map<number, number>();
export const activeProgressMessageIds = new Map<number, number>();
export const finalizedProgressMessages = new Set<number>();
export const sentApprovalIds = new Set<string>();

/** Approval ids are remembered so a prompt is only ever posted once, but they
 *  are otherwise useless after the run. Cap the set so a long-lived session
 *  cannot grow it without bound, dropping the oldest (insertion order). */
const SENT_APPROVAL_IDS_MAX = 200;
function rememberSentApproval(id: string): void {
  sentApprovalIds.add(id);
  while (sentApprovalIds.size > SENT_APPROVAL_IDS_MAX) {
    const first = sentApprovalIds.values().next();
    if (first.done) break;
    sentApprovalIds.delete(first.value);
  }
}

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
  const subagentStore = await import("../ai/store/subagentRunStore");
  const { extractToolSummaries, formatLiveProgress, resolveModelLabel } =
    await import("./progressFormat");
  let progressMessageId: number | null = null;
  let lastLiveText = "";
  let lastSubstantiveKey = "";
  let lastSentAt = 0;
  let lastTypingAt = 0;
  let lastLiveTextPokeAt = 0;
  // Consecutive failures of the FIRST progress send. A persistent failure (the
  // bot blocked by the user, the chat deleted, HTML the fallback also rejects)
  // would otherwise re-send every second for the whole run, and that request
  // flood trips Telegram's per-token rate limit, breaking long-polling too.
  let progressSendFailures = 0;
  // Per-id send attempts, so a prompt whose send failed is retried a bounded
  // number of times instead of being recorded as delivered (lost forever) or
  // retried forever.
  const approvalSendAttempts = new Map<string, number>();
  const elicitationSendAttempts = new Map<string, number>();
  const sentElicitationIds = new Set<string>();
  const started = Date.now();
  let lastActiveAt = Date.now();
  const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
  const MAX_TOTAL_WAIT_MS = 3 * 60 * 60 * 1000;
  const MAX_PROMPT_SEND_ATTEMPTS = 3;
  // Tracks step-cap detection so the auto-continue re-check runs at most once.
  let stepCapNotified = false;

  if (mode === "question") {
    return;
  }

  if (initialText) {
    progressMessageId = await sendProgressMessage(chatId, initialText, signal);
    if (progressMessageId != null) {
      activeProgressMessageIds.set(chatId, progressMessageId);
    }
    lastLiveText = initialText;
    lastSentAt = Date.now();
    lastTypingAt = Date.now();
    await sendTyping(chatId, signal).catch(() => {});
  }

  try {
    while (
      !signal.aborted &&
      Date.now() - lastActiveAt < INACTIVITY_TIMEOUT_MS &&
      Date.now() - started < MAX_TOTAL_WAIT_MS
    ) {
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
      const activeTools = hasActiveToolCalls(chat);
      const busy =
        runBusy(chatStatus, status, pendingApprovals.length > 0, activeTools) ||
        status === "thinking" ||
        status === "streaming" ||
        status === "awaiting-approval" ||
        activeTools ||
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
      // The assistant's own prose, so the card shows what it is saying as it
      // says it. Taken from text parts only: reasoning is the agent thinking
      // aloud, and publishing it would show raw scratchpad in the chat.
      const answerText = lastAssistant
        ? messageText(
            lastAssistant as {
              role: string;
              parts?: Array<{ type?: string; text?: string }>;
            },
          )
        : "";

      // Format compact live progress
      const rawSubagents =
        subagentStore.useSubagentRunStore.getState().bySession[sessionId] ?? [];
      const subagents = rawSubagents.map((s) => ({
        label: s.label || s.type,
        status: s.status,
        currentStep: s.currentStep,
      }));

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
        subagents,
        elapsedMs: now - started,
        mode,
        answerText,
        modelLabel: await resolveModelLabel(
          store.useChatStore.getState().selectedModelId,
        ),
      });

      const substantiveKey = JSON.stringify({
        liveStatus,
        round: meta.round,
        step,
        tools: toolSummaries.map((t) => `${t.toolName}:${t.state}:${t.input}`),
        todosCount: todos.length,
        todosDone: todos.filter((t) => t.status === "completed").length,
        subagents: subagents.map(
          (s) => `${s.label}:${s.status}:${s.currentStep}`,
        ),
        answerLen: answerText.length,
      });
      const hasSubstantiveChange = substantiveKey !== lastSubstantiveKey;
      if (hasSubstantiveChange || busy) {
        lastActiveAt = now;
      }

      if (!progressMessageId) {
        const sentId = await sendProgressMessage(chatId, liveText, signal);
        if (sentId == null) {
          progressSendFailures += 1;
          if (progressSendFailures >= MAX_PROMPT_SEND_ATTEMPTS) return;
        } else {
          progressSendFailures = 0;
          progressMessageId = sentId;
          activeProgressMessageIds.set(chatId, sentId);
          lastLiveText = liveText;
          lastSubstantiveKey = substantiveKey;
          lastSentAt = now;
          lastTypingAt = now;
          // Telegram client clears typing indicator when a message is received; re-send typing immediately.
          await sendTyping(chatId, signal).catch(() => {});
        }
      } else if (hasSubstantiveChange && now - lastSentAt >= 1500) {
        lastLiveText = liveText;
        lastSubstantiveKey = substantiveKey;
        const ok = await editProgressMessage(
          chatId,
          progressMessageId,
          liveText,
          signal,
        );
        if (ok) {
          lastSentAt = now;
        }
      } else if (
        busy &&
        now - lastLiveTextPokeAt >= 6000 &&
        liveText !== lastLiveText
      ) {
        // Ticking elapsed timer or keepalive: poke at relaxed interval (6s) to avoid 429 Flood Control
        lastLiveTextPokeAt = now;
        await sendTyping(chatId, signal).catch(() => {});
        const ok = await editProgressMessage(
          chatId,
          progressMessageId,
          liveText,
          signal,
        ).catch(() => false);
        if (ok) {
          lastLiveText = liveText;
          lastSentAt = now;
        }
      }

      // Surface pending approvals as interactive inline buttons in Telegram
      for (const p of pendingApprovals) {
        if (sentApprovalIds.has(p.id)) continue;
        const attempts = approvalSendAttempts.get(p.id) ?? 0;
        if (attempts >= MAX_PROMPT_SEND_ATTEMPTS) {
          // Persistent send failure: stop retrying so the loop does not hammer
          // Telegram. /approve and /deny still work from the chat.
          rememberSentApproval(p.id);
          continue;
        }
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
        // Record only a delivered prompt: recording first meant a single failed
        // send lost the approval forever and the run sat in awaiting-approval
        // with nothing for the user to click. `sendKeyboard` resolves false
        // (never rejects) so the result is the delivery signal.
        const ok = await sendKeyboard(
          chatId,
          `Action Approval Required:\nTool: ${p.toolName}\nTarget: ${p.summary || p.toolName}\n(Tap button below or reply /approve /deny)`,
          keyboard,
          signal,
        );
        if (ok) {
          rememberSentApproval(p.id);
          approvalSendAttempts.delete(p.id);
        } else {
          approvalSendAttempts.set(p.id, attempts + 1);
        }
        lastSentAt = now;
      }

      // Surface questions from ask_user (elicitation)
      const elStore = await import("../ai/store/elicitationStore");
      const elPending = elStore.useElicitationStore.getState().pending;
      for (const el of elPending) {
        if (sentElicitationIds.has(el.id)) continue;
        const attempts = elicitationSendAttempts.get(el.id) ?? 0;
        if (attempts >= MAX_PROMPT_SEND_ATTEMPTS) {
          sentElicitationIds.add(el.id);
          continue;
        }
        const keyboard: InlineButton[][] = el.options
          .slice(0, 6)
          .map((opt, i) => [
            { text: opt.slice(0, 40), callback_data: `el:${el.id}:${i}` },
          ]);
        // Always offered, and deliberately last: a question the agent asked is
        // not always a question the user wants to answer, and without this the
        // only way out was to type /stop. A chooser with no decline is a dead
        // end, and a dead end is what makes someone abandon the bot.
        keyboard.push([
          {
            text: ">> Tidak dulu (lewati)",
            callback_data: `el:${el.id}:decline`,
          },
        ]);
        const ok = await sendKeyboard(
          chatId,
          `Agent Question:\n${el.question}`,
          keyboard,
          signal,
        );
        if (ok) {
          sentElicitationIds.add(el.id);
          elicitationSendAttempts.delete(el.id);
        } else {
          elicitationSendAttempts.set(el.id, attempts + 1);
        }
        lastSentAt = now;
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
            // The Continue keyboard is sent by runAgentAndStream, which owns
            // the post-run prompts. Sending it here too produced two identical
            // buttons (and two queued resumes if both were tapped).
            stepCapNotified = true;
            break;
          }
          stepCapNotified = false;
        }
      }

      await sleep(signal, 1000);
    }
  } finally {
    activeProgressMessageIds.delete(chatId);
    // A `return` used to short-circuit here when this message was already
    // finalized (by the stop or approval path). That is a real bug, not lint
    // noise: a `return` inside `finally` SWALLOWS an exception thrown by the
    // progress loop above, so a run that failed would finish as a clean
    // "done", the error gone and nothing in the log to say why. Conjoining the
    // condition keeps the same skip without taking the failure with it.
    if (
      progressMessageId &&
      !finalizedProgressMessages.has(progressMessageId)
    ) {
      // State the outcome rather than a bare "Completed.". `stoppedByUser` and
      // `stopReason` are what the desktop app uses to tell a finished run from
      // one the user stopped, one that hit the step limit and one that failed;
      // without them every ending read the same in the chat.
      const finalMeta = store.useChatStore.getState().agentMeta;
      const chat = store.getChat(sessionId);
      const aqStore = await import("../ai/store/approvalQueueStore");
      const pendingApprovals = getPendingApprovals(
        sessionId,
        store,
        aqStore.useApprovalQueue,
      );
      const activeTools = hasActiveToolCalls(chat);
      const isStillBusy =
        runBusy(
          chat?.status ?? "",
          finalMeta.status,
          pendingApprovals.length > 0,
          activeTools,
        ) ||
        finalMeta.status === "thinking" ||
        finalMeta.status === "streaming" ||
        finalMeta.status === "awaiting-approval" ||
        activeTools;

      const outcome: import("./progressFormat").RunOutcome = finalMeta.stoppedByUser
        ? "stopped"
        : finalMeta.error
          ? "error"
          : finalMeta.stopReason === "step-cap"
            ? "step-cap"
            : isStillBusy
              ? "still-running"
              : "done";

      // If the run completed cleanly and an assistant answer is already present,
      // preserve that answer text and drop backend process lines.
      const messages = chat?.messages ?? [];
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const answerText = lastAssistant
        ? messageText(
            lastAssistant as {
              role: string;
              parts?: Array<{ type?: string; text?: string }>;
            },
          )
        : "";

      const doneText = formatLiveProgress({
        status: isStillBusy ? "thinking" : "idle",
        completed: !isStillBusy,
        outcome,
        elapsedMs: Date.now() - started,
        answerText: outcome === "done" && answerText ? answerText : undefined,
        todos:
          todosStore.useTodosStore.getState().bySession[sessionId]?.items ?? [],
      });
      await editProgressMessage(
        chatId,
        progressMessageId,
        doneText,
        AbortSignal.timeout(4000),
      ).catch(() => {});
      if (!isStillBusy && (!answerText || outcome !== "done")) {
        lastFinishedProgressMessageIds.set(chatId, progressMessageId);
      }
    } else if (progressMessageId) {
      // Already finalized by the stop / approval path - only the marker is left.
      finalizedProgressMessages.delete(progressMessageId);
    }
  }
}
