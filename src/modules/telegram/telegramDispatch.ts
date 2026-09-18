// Telegram task dispatch, agent execution streaming, and bi-directional mirror.
//
// Extracted from bot.ts so the polling and command layers only route to
// dispatch functions.

// Still used by runMirror (the Termigo -> Telegram direction), which streams a
// mirrored message by editing it in place. The Telegram -> Termigo direction no
// longer needs these: its interim text now lives inside the progress card.
import {
  type MirrorStreamState,
  planMirrorDelivery,
  startedState,
} from "./mirrorStream";
import { useTelegramStore } from "./store";
import {
  deleteTelegramMessage,
  editProgressMessage,
  sendDocument,
  sendKeyboard,
  sendPhoto,
  sendProgressMessage,
  sendTelegram,
  sendTyping,
  splitTelegramText,
} from "./telegramApi";
import {
  getMirrorPauseCount,
  isMessageSeen,
  isTelegramOriginText,
  markMessageSeen,
  pauseMirror,
  recordTelegramText,
  rememberTelegramOrigin,
  resumeMirror,
  telegramOriginMessageIds,
} from "./telegramDedup";
import {
  type ChatLike,
  countAssistantMessages,
  getPendingApprovals,
  hasActiveToolCalls,
  lastAssistantText,
  matchElicitationAnswer,
  messageText,
  runBusy,
} from "./telegramHelpers";
import {
  approvalWaitLine,
  logRelayInfo,
  logRelayWarn,
  relayErrorLine,
  runOutcomeLine,
} from "./telegramLog";
import {
  activeProgressMessageIds,
  finalizedProgressMessages,
  lastFinishedProgressMessageIds,
  progressCtrls,
  publishProgress,
  sentApprovalIds,
} from "./telegramProgress";

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

/** Track stop reasons already notified by the mirror loop to prevent spamming buttons. */
let mirrorLastNotifiedStopKey = "";
const mirrorSentElicitationIds = new Set<string>();
const MIRROR_SENT_ELICITATION_IDS_MAX = 200;
function rememberMirrorElicitation(id: string): void {
  mirrorSentElicitationIds.add(id);
  while (mirrorSentElicitationIds.size > MIRROR_SENT_ELICITATION_IDS_MAX) {
    const first = mirrorSentElicitationIds.values().next();
    if (first.done) break;
    mirrorSentElicitationIds.delete(first.value);
  }
}

/** How many times the mirror re-attempts a Termigo -> Telegram send before it
 *  gives up and marks the message seen. Bounded so a permanently undeliverable
 *  message cannot be re-sent every two seconds for the life of the session. */
const MAX_MIRROR_SEND_ATTEMPTS = 3;
/** Consecutive mirror-send failures, keyed by session + message. */
const RESUME_COOLDOWN_MS = 2_000;
const resumeCooldowns = new Map<number, number>();

function isResumeOnCooldown(chatId: number): boolean {
  const last = resumeCooldowns.get(chatId) ?? 0;
  if (Date.now() - last < RESUME_COOLDOWN_MS) return true;
  resumeCooldowns.set(chatId, Date.now());
  return false;
}
const mirrorSendFailures = new Map<string, number>();

/**
 * Mirror messages currently being streamed into Telegram, keyed by session +
 * transcript message. Present means "a Telegram message exists for this
 * transcript message and its text can still grow", which is what makes an edit
 * possible instead of a duplicate send.
 */
const mirrorStreams = new Map<string, MirrorStreamState>();

/** Bound on in-flight streamed messages, so a long-lived process cannot leak. */
const MIRROR_STREAM_MAX = 50;

function setMirrorStream(key: string, state: MirrorStreamState): void {
  mirrorStreams.set(key, state);
  while (mirrorStreams.size > MIRROR_STREAM_MAX) {
    const oldest = mirrorStreams.keys().next();
    if (oldest.done) break;
    mirrorStreams.delete(oldest.value);
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Terminal lines waitForReply can return, named so the send loop can tell a
 *  real answer apart from a status fallback without string-matching drift. */
export const NO_OUTPUT_REPLY = "Run produced no text output.";
export const STILL_RUNNING_REPLY =
  "Run is still in progress or waiting for approval. Use Telegram inline buttons or /status to check.";
export const STEP_LIMIT_REPLY =
  "Step limit reached. Use /continue or the Continue button to proceed.";
const FALLBACK_REPLIES = new Set([
  NO_OUTPUT_REPLY,
  STILL_RUNNING_REPLY,
  STEP_LIMIT_REPLY,
]);

/**
 * Send a reply plus any Mermaid blocks rendered to PNG, so a diagram the agent
 * produced actually shows in Telegram instead of as raw source. Text is sent
 * first (never dropped); diagrams are best-effort after it.
 */
async function sendReplyWithDiagrams(
  chatId: number | string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  await sendTelegram(chatId, text, signal);
  await sendDiagrams(chatId, text, signal);
}

/** The Mermaid PNGs for a finished answer, best-effort. */
async function sendDiagrams(
  chatId: number | string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const { extractMermaidBlocks, renderMermaidToPng } = await import(
    "./mermaidImage"
  );
  const blocks = extractMermaidBlocks(text);
  for (const block of blocks) {
    const png = await renderMermaidToPng(block);
    if (png) {
      await sendPhoto(chatId, png, "Mermaid diagram", signal).catch(() => {});
    }
  }
}

/**
 * Deliver an answer that was being streamed by editing its Telegram message.
 *
 * Only the first chunk can replace the existing message; anything past one
 * message has to follow as new messages, because an edit cannot be longer than
 * the limit. Reuses the shared splitter so a long answer keeps its line breaks.
 */
async function finalizeStreamedMessage(
  chatId: number | string,
  messageId: number,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const chunks = splitTelegramText(text);
  const first = chunks[0] ?? "";
  const edited = await editProgressMessage(chatId, messageId, first, signal);
  if (edited) {
    for (const chunk of chunks.slice(1)) {
      if (signal.aborted) break;
      await sendTelegram(chatId, chunk, signal).catch(() => {});
    }
  } else {
    logRelayWarn(
      `could not finalize streamed message ${messageId}; falling back to send`,
    );
    await sendTelegram(chatId, text, signal).catch(() => {});
  }
  await sendDiagrams(chatId, text, signal);
}

/** Local report/document files the agent previewed via `preview_file` since the
 *  baseline, so a finished HTML/Markdown report (or image) can be shared to the
 *  chat. PDFs hit the pane's not-renderable error and are skipped. */
function reportFilesFromAssistant(
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
  sinceCount: number,
): string[] {
  const chat = getChat(sessionId);
  if (!chat) return [];
  const assistants = chat.messages.filter((m) => m.role === "assistant");
  const relevant = assistants.slice(sinceCount);
  const paths: string[] = [];
  for (const m of relevant) {
    for (const p of m.parts ?? []) {
      // Built-in tools arrive as `tool-<name>` parts (only dynamic/MCP tools
      // carry `toolName`), so checking `type === "tool-call"` alone never
      // matched and this whole report-sending path was dead.
      const type = typeof p.type === "string" ? p.type : "";
      const toolName =
        typeof p.toolName === "string"
          ? p.toolName
          : type.startsWith("tool-")
            ? type.slice(5)
            : "";
      if (!toolName.includes("preview_file")) continue;
      const out = p.output as
        | { ok?: boolean; error?: string; path?: string }
        | undefined;
      if (out?.ok && out.path) paths.push(out.path);
    }
  }
  return [...new Set(paths)];
}

/** Best-effort: send report files (HTML/Markdown, images) the agent previewed. */
async function sendReportFiles(
  chatId: number | string,
  getChat: (id: string) => ChatLike | undefined,
  sessionId: string,
  sinceCount: number,
  signal: AbortSignal,
): Promise<void> {
  const paths = reportFilesFromAssistant(getChat, sessionId, sinceCount);
  if (paths.length === 0) return;
  const { native } = await import("../ai/lib/native");
  const { readFile, readImageBase64, readFileBase64 } = native;
  const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
  for (const path of paths) {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      const img = await readImageBase64(path).catch(() => null);
      if (img) {
        const dataUrl = `data:${img.media_type};base64,${img.data}`;
        await sendPhoto(chatId, dataUrl, "Report image", signal).catch(
          () => {},
        );
      }
    } else {
      // Prefer the raw base64 reader so binary files (PDF) can be uploaded;
      // fall back to the text reader for a plain HTML/Markdown report.
      const bin = await readFileBase64(path).catch(() => null);
      if (bin) {
        const bytes = base64ToBytes(bin.data);
        const name = bin.file_name || path.split(/[\\/]/).pop() || "report";
        const caption =
          bin.media_type === "application/pdf" ? "Report (PDF)" : "Report";
        await sendDocument(chatId, bytes, name, caption, signal).catch(
          () => {},
        );
      } else {
        const r = await readFile(path).catch(() => null);
        if (r && r.kind === "text") {
          const bytes = new TextEncoder().encode(r.content);
          const name = path.split(/[\\/]/).pop() ?? "report.txt";
          await sendDocument(chatId, bytes, name, "Report", signal).catch(
            () => {},
          );
        }
      }
    }
  }
}

/**
 * Mirror the in-app conversation into Telegram in the other direction: a
 * message typed in Termigo (and the agent's reply once the run settles) shows
 * up in the bot's chat. Suppressed while the bot is relaying a Telegram run so
 * it doesn't echo messages it injected itself.
 */
export async function runMirror(signal: AbortSignal): Promise<void> {
  let seenSession = "";
  while (!signal.aborted) {
    try {
      const store = await import("../ai/store/chatStore");
      const { enabled, chatId } = useTelegramStore.getState();
      const state = store.useChatStore.getState();
      if (enabled && chatId && state.activeSessionId) {
        const sessionId = state.activeSessionId;
        const chat = store.getChat(sessionId);
        const messages = chat?.messages ?? [];
        if (sessionId !== seenSession) {
          seenSession = sessionId;
          mirrorLastNotifiedStopKey = "";
          // Seed so pre-existing history is not replayed to Telegram - only
          // messages added from now on are mirrored.
          for (const m of messages) {
            markMessageSeen(m.id, sessionId, m.role, messageText(m));
          }
          // Anything still mid-stream belongs to the session being left, and
          // its transcript message is now seeded as seen, so an edit would
          // target a message the loop no longer walks.
          mirrorStreams.clear();
        }
        const settled =
          state.agentMeta.status === "idle" ||
          state.agentMeta.status === "error";
        for (const m of messages) {
          const text = messageText(m);
          if (isMessageSeen(m.id, sessionId, m.role, text)) continue;

          // Telegram-origin traffic is handled by the bot relay itself
          // (dispatchAndStream); never mirror it back.
          if (
            getMirrorPauseCount() > 0 ||
            (m.id && telegramOriginMessageIds.has(m.id)) ||
            (m.role === "user" && isTelegramOriginText(text))
          ) {
            markMessageSeen(m.id, sessionId, m.role, text);
            continue;
          }

          const mirrorKey = `${sessionId}:${m.id ?? text.slice(0, 40)}`;

          // An assistant message is streamed rather than held to the end of the
          // run: one message accumulates every step, so waiting for `settled`
          // delivered all of it last and out of order.
          if (m.role === "assistant") {
            // `previous` is captured before anything is stored, so a failed
            // send can leave the recorded state untouched and the same send is
            // retried next tick instead of being skipped as already delivered.
            const previous = mirrorStreams.get(mirrorKey) ?? null;
            const plan = planMirrorDelivery({
              text,
              settled,
              state: previous,
              now: Date.now(),
            });

            let delivered = true;
            try {
              if (plan.send?.kind === "start") {
                const id = await sendProgressMessage(
                  chatId,
                  plan.send.text,
                  signal,
                );
                delivered = id !== null;
                if (delivered) {
                  const next = startedState(id as number, plan);
                  if (next) setMirrorStream(mirrorKey, next);
                }
              } else if (plan.send?.kind === "edit") {
                delivered = previous
                  ? await editProgressMessage(
                      chatId,
                      previous.messageId,
                      plan.send.text,
                      signal,
                    )
                  : false;
                // Only record the taller text once it is actually shown.
                if (delivered && plan.next) {
                  setMirrorStream(mirrorKey, plan.next);
                }
              } else if (plan.send?.kind === "finalize") {
                if (previous) {
                  await finalizeStreamedMessage(
                    chatId,
                    previous.messageId,
                    plan.send.text,
                    signal,
                  );
                } else {
                  await sendReplyWithDiagrams(chatId, plan.send.text, signal);
                }
              } else if (plan.send?.kind === "send") {
                await sendReplyWithDiagrams(chatId, plan.send.text, signal);
              } else if (plan.next) {
                // Nothing to send this tick (throttled, or waiting out an
                // overflow). Still worth recording, since `next` carries the
                // overflow flag the later ticks read.
                setMirrorStream(mirrorKey, plan.next);
              }
            } catch {
              delivered = false;
            }

            if (plan.markSeen && delivered) {
              // Only now, with the whole answer in the chat: marking a growing
              // message as seen earlier is what truncates a reply, because the
              // dedup key is the message id, not its text.
              markMessageSeen(m.id, sessionId, m.role, text);
              mirrorStreams.delete(mirrorKey);
              mirrorSendFailures.delete(mirrorKey);
            } else if (!delivered) {
              const attempts = (mirrorSendFailures.get(mirrorKey) ?? 0) + 1;
              if (attempts >= MAX_MIRROR_SEND_ATTEMPTS) {
                logRelayWarn(
                  `mirror gave up on a ${m.role} message after ${attempts} attempts (session ${sessionId})`,
                );
                mirrorSendFailures.delete(mirrorKey);
                mirrorStreams.delete(mirrorKey);
                markMessageSeen(m.id, sessionId, m.role, text);
              } else {
                mirrorSendFailures.set(mirrorKey, attempts);
              }
            }
            continue;
          }

          // A user message typed in the app: one-shot, whole.
          if (!text) {
            markMessageSeen(m.id, sessionId, m.role, text);
            continue;
          }
          try {
            await sendReplyWithDiagrams(chatId, text, signal);
            markMessageSeen(m.id, sessionId, m.role, text);
            mirrorSendFailures.delete(mirrorKey);
          } catch {
            // Do NOT mark a failed send as seen: mirroring is best-effort, so
            // the next tick should retry. Bound the retries so a permanently
            // undeliverable message cannot be re-sent every two seconds.
            const attempts = (mirrorSendFailures.get(mirrorKey) ?? 0) + 1;
            if (attempts >= MAX_MIRROR_SEND_ATTEMPTS) {
              // Giving up is a silent drop: the message is marked seen so it is
              // never retried, so without this line a reply that never reached
              // Telegram looks like one that was never generated.
              logRelayWarn(
                `mirror gave up on a ${m.role} message after ${attempts} attempts (session ${sessionId})`,
              );
              mirrorSendFailures.delete(mirrorKey);
              markMessageSeen(m.id, sessionId, m.role, text);
            } else {
              mirrorSendFailures.set(mirrorKey, attempts);
            }
          }
        }

        if (getMirrorPauseCount() === 0) {
          const chatStatus = chat?.status ?? "";
          const aqStore = await import("../ai/store/approvalQueueStore");
          const pending = sessionId
            ? getPendingApprovals(sessionId, store, aqStore.useApprovalQueue)
            : [];

          // Surface pending approvals as interactive cards in Telegram
          for (const p of pending) {
            if (sentApprovalIds.has(p.id)) continue;
            const prefix = p.source === "queue" ? "aq" : "ap";
            const keyboard = [
              [
                {
                  text: "Approve",
                  callback_data: `${prefix}:approve:${p.id}`,
                },
                {
                  text: "Deny",
                  callback_data: `${prefix}:deny:${p.id}`,
                },
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
            const ok = await sendKeyboard(
              chatId,
              `Action Approval Required:\nTool: ${p.toolName}\nTarget: ${p.summary || p.toolName}\n(Tap button below or reply /approve /deny)`,
              keyboard,
              signal,
            );
            if (ok) {
              sentApprovalIds.add(p.id);
            }
          }

          // Surface pending questions from ask_user (elicitation)
          const elStore = await import("../ai/store/elicitationStore");
          const elPending = elStore.useElicitationStore.getState().pending;
          for (const el of elPending) {
            if (mirrorSentElicitationIds.has(el.id)) continue;
            const keyboard = el.options.slice(0, 6).map((opt, i) => [
              { text: opt.slice(0, 40), callback_data: `el:${el.id}:${i}` },
            ]);
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
              rememberMirrorElicitation(el.id);
            }
          }

          // Surface continue button if agent stopped at step budget cap or guard pause
          if (
            settled &&
            state.agentMeta.status === "idle" &&
            pending.length === 0 &&
            !state.agentMeta.stoppedByUser
          ) {
            const stopReason = state.agentMeta.stopReason;
            const currentRound = state.agentMeta.runRound ?? 0;
            const stopKey = `${sessionId}:${currentRound}:${stopReason ?? ""}`;
            if (
              stopReason === "step-cap" &&
              mirrorLastNotifiedStopKey !== stopKey
            ) {
              mirrorLastNotifiedStopKey = stopKey;
              const { stepBudgetForRound } = await import("../ai/config");
              const nextBudget = stepBudgetForRound(currentRound + 1);
              await sendKeyboard(
                chatId,
                `Step limit reached (round ${currentRound + 1}). Continue to next round (${nextBudget} steps)?`,
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
            } else if (
              stopReason &&
              stopReason !== "step-cap" &&
              mirrorLastNotifiedStopKey !== stopKey
            ) {
              mirrorLastNotifiedStopKey = stopKey;
              await sendKeyboard(
                chatId,
                `Agent paused (${stopReason}). Choose an action below or send your next instruction:`,
                [
                  [
                    {
                      text: ">> Continue anyway",
                      callback_data: "resume:run",
                    },
                  ],
                ],
                signal,
              ).catch(() => {});
            }
          } else if (state.agentMeta.status !== "idle") {
            mirrorLastNotifiedStopKey = "";
          }

          const activeTools = hasActiveToolCalls(chat);
          if (
            runBusy(
              chatStatus,
              state.agentMeta.status,
              pending.length > 0,
              activeTools,
            ) ||
            activeTools
          ) {
            await sendTyping(chatId, signal).catch(() => {});
          }
        }
      }
    } catch {
      // Mirroring is best-effort; never let it break the long-poll loop.
    }
    await sleep(signal, 2000);
  }
}

/**
 * Wait until the dispatched run produces a fresh assistant answer and settles.
 * Returns the text to send back, or a short status line when nothing came.
 *
 * `onPartial` fires on every tick that has fresh assistant text, so the caller
 * can show it while the run is still working. It is awaited, so a slow send
 * throttles the loop instead of queueing edits.
 */
async function waitForReply(
  store: typeof import("../ai/store/chatStore"),
  signal: AbortSignal,
  sessionId: string,
  baseline: number,
  onPartial?: (text: string) => Promise<void>,
): Promise<string> {
  const started = Date.now();
  let lastActiveAt = Date.now();
  const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
  const MAX_TOTAL_WAIT_MS = 3 * 60 * 60 * 1000;
  let everBusy = false;
  const aqStore = await import("../ai/store/approvalQueueStore");
  while (
    !signal.aborted &&
    Date.now() - lastActiveAt < INACTIVITY_TIMEOUT_MS &&
    Date.now() - started < MAX_TOTAL_WAIT_MS
  ) {
    const chat = store.getChat(sessionId);
    const appStatus = store.useChatStore.getState().agentMeta.status;
    const chatStatus = chat?.status ?? "";
    const pending = getPendingApprovals(
      sessionId,
      store,
      aqStore.useApprovalQueue,
    );
    const activeTools = hasActiveToolCalls(chat);
    const busy =
      runBusy(chatStatus, appStatus, pending.length > 0, activeTools) ||
      activeTools;
    if (busy) {
      everBusy = true;
      lastActiveAt = Date.now();
    }
    const count = countAssistantMessages(store.getChat, sessionId);
    if (count > baseline) {
      lastActiveAt = Date.now();
    }

    if (count > baseline) {
      // Show what the agent has written so far. Sent BEFORE the settle check on
      // purpose: waiting for the full answer meant a task that spends minutes
      // running tools sent nothing at all until it finished, which reads as
      // "the agent is ignoring me".
      if (onPartial) {
        const soFar = lastAssistantText(store.getChat, sessionId, baseline);
        if (soFar) await onPartial(soFar);
      }
      // A fresh answer exists; return it once the run has settled.
      if (!busy) {
        // No text anywhere in the run's fresh messages is the one case with
        // nothing to send. Returning an ad-hoc line here meant it was not in
        // FALLBACK_REPLIES, so the relay counted it as a real answer and told
        // the user "Run finished." The named constant is classified correctly
        // and says what actually happened.
        return (
          lastAssistantText(store.getChat, sessionId, baseline) ??
          NO_OUTPUT_REPLY
        );
      }
    } else {
      const err = store.useChatStore.getState().agentMeta.error;
      if (err) {
        const fresh = lastAssistantText(store.getChat, sessionId, baseline);
        if (fresh) {
          return fresh;
        }
        const sanitized = String(err).trim();
        if (
          sanitized.includes("content you provided") ||
          sanitized.includes("machine outputted") ||
          sanitized.includes("blocked")
        ) {
          return "The provider blocked the request or response. Please rephrase or switch model in Settings → Providers.";
        }
        return `Run ended with an error: ${sanitized}`;
      }
      if (everBusy && !busy) {
        const stopReason = store.useChatStore.getState().agentMeta.stopReason;
        if (stopReason === "step-cap") {
          await sleep(signal, 2000);
          const afterWait = store.useChatStore.getState().agentMeta;
          if (
            afterWait.status === "thinking" ||
            afterWait.status === "streaming"
          ) {
            continue;
          }
          if (
            afterWait.stopReason === "step-cap" &&
            afterWait.status === "idle"
          ) {
            return STEP_LIMIT_REPLY;
          }
        }
        return NO_OUTPUT_REPLY;
      }
      if (!busy && Date.now() - started > 25_000) {
        return NO_OUTPUT_REPLY;
      }
    }
    await sleep(signal, 1500);
  }
  return STILL_RUNNING_REPLY;
}

export async function runAgentAndStream(
  action: () => Promise<boolean>,
  chatId: number,
  signal: AbortSignal,
  initialText?: string,
  mode: "task" | "question" = "task",
): Promise<void> {
  // Counters for the one-line outcome, declared outside the try so the finally
  // reports them on every path - including the early returns, which is exactly
  // where a run that never answered used to disappear without a trace.
  const startedAt = Date.now();
  let sessionIdForLog = "";
  let replies = 0;
  let sentChars = 0;
  let seenFallback = false;
  let pendingAtEnd = 0;
  let approvalWaitLogged = false;
  let stopReasonAtEnd: string | null = null;
  try {
    const store = await import("../ai/store/chatStore");
    if (!store.useChatStore.getState().activeSessionId) {
      store.useChatStore.getState().newSession();
    }
    const sessionId = store.useChatStore.getState().activeSessionId;
    if (!sessionId) return;
    sessionIdForLog = sessionId;
    const baseline = countAssistantMessages(store.getChat, sessionId);

    // Snapshot existing message IDs prior to injecting this prompt.
    const priorChat = store.getChat(sessionId);
    const priorIds = new Set(
      (priorChat?.messages ?? []).map((m) => m.id).filter(Boolean) as string[],
    );

    // Pause the mirror before injecting the user message.
    pauseMirror();
    try {
      // Stream live progress and continuous typing alongside the run, superseding any prior stream.
      const progressCtl = new AbortController();
      progressCtrls.get(chatId)?.abort();
      progressCtrls.set(chatId, progressCtl);
      void publishProgress(
        chatId,
        sessionId,
        progressCtl.signal,
        initialText,
        mode,
      ).catch(() => {});

      // Dedicated continuous typing heartbeat: ensures Telegram client consistently
      // displays "...typing" while the agent is busy (thinking, streaming, or running tools).
      let typingTimer: ReturnType<typeof setInterval> | null = setInterval(
        async () => {
          if (signal.aborted) {
            if (typingTimer) clearInterval(typingTimer);
            return;
          }
          const currentChat = store.getChat(sessionId);
          const currentAppStatus =
            store.useChatStore.getState().agentMeta.status;
          const currentChatStatus = currentChat?.status ?? "";
          const aqStore = await import("../ai/store/approvalQueueStore");
          const pending = getPendingApprovals(
            sessionId,
            store,
            aqStore.useApprovalQueue,
          );
          const activeTools = hasActiveToolCalls(currentChat);
          const busy =
            runBusy(
              currentChatStatus,
              currentAppStatus,
              pending.length > 0,
              activeTools,
            ) || activeTools;
          if (busy) {
            await sendTyping(chatId, signal).catch(() => {});
          }
        },
        3000,
      );

      try {
        const accepted = await action();
        if (!accepted) {
          progressCtl.abort();
          logRelayWarn(
            `run ${sessionId} not accepted - the runtime refused to start the agent`,
          );
          await sendTelegram(
            chatId,
            "Could not start or resume the agent run - check the model / API key.",
            signal,
          );
          return;
        }

        // Immediately mark the freshly-injected user message as seen and Telegram-origin.
        const chatAfterSend = store.getChat(sessionId);
        for (const m of chatAfterSend?.messages ?? []) {
          if (m.id && !priorIds.has(m.id)) {
            markMessageSeen(m.id, sessionId, m.role, messageText(m));
            rememberTelegramOrigin(m.id);
          }
        }

        let currentBaseline = baseline;
        let stopReasonSnapshot: string | null = null;
        let fallbackSent = false;
        let settleStart = Date.now();
        const SETTLE_TIMEOUT = 25_000;

        while (!signal.aborted) {
          const reply = await waitForReply(
            store,
            signal,
            sessionId,
            currentBaseline,
          );
          settleStart = Date.now();
          stopReasonSnapshot =
            store.useChatStore.getState().agentMeta.stopReason;
          stopReasonAtEnd = stopReasonSnapshot;

          // Surface a status fallback at most once per run. It must NOT skip
          // the settle check below: `continue` used to jump straight back into
          // waitForReply, so a settled run with no fresh assistant text spun
          // here forever (one 25s wait per cycle) instead of reaching `break`.
          const isFallback = FALLBACK_REPLIES.has(reply);
          if (isFallback && fallbackSent) {
            // Already told the user once. Fall through to the settle check so
            // an actually-idle run can end this handler.
          } else {
            if (isFallback) fallbackSent = true;
            const activeProgId = activeProgressMessageIds.get(chatId);
            if (
              !isFallback &&
              activeProgId &&
              !finalizedProgressMessages.has(activeProgId)
            ) {
              // Task selesai: hentikan loop live progress, hilangkan backend task
              // dari pesan progress dan gantikan langsung dengan jawaban AI,
              // sehingga jawaban tidak perlu dikirim ulang secara terpisah.
              progressCtl.abort();
              activeProgressMessageIds.delete(chatId);
              finalizedProgressMessages.add(activeProgId);
              await finalizeStreamedMessage(chatId, activeProgId, reply, signal);
              replies += 1;
              sentChars += reply.length;
            } else if (
              !isFallback &&
              activeProgId &&
              finalizedProgressMessages.has(activeProgId)
            ) {
              // Sudah difinalisasikan ke pesan progress; tidak perlu kirim dobel.
              replies += 1;
              sentChars += reply.length;
            } else {
              await sendReplyWithDiagrams(chatId, reply, signal);
              replies += 1;
              sentChars += reply.length;
              if (isFallback) seenFallback = true;
            }
          }

          // Immediately mark fresh assistant message(s) as seen and Telegram-origin.
          const chatAfterReply = store.getChat(sessionId);
          for (const m of chatAfterReply?.messages ?? []) {
            if (m.id && !priorIds.has(m.id)) {
              markMessageSeen(m.id, sessionId, m.role, messageText(m));
              rememberTelegramOrigin(m.id);
            }
          }

          currentBaseline = countAssistantMessages(store.getChat, sessionId);

          const queued =
            store.useChatStore.getState().steerQueue.pending.length > 0;
          const appStatus = store.useChatStore.getState().agentMeta.status;
          const chatStatus = store.getChat(sessionId)?.status ?? "";
          const aqStore = await import("../ai/store/approvalQueueStore");
          const pendingApprovals = getPendingApprovals(
            sessionId,
            store,
            aqStore.useApprovalQueue,
          );
          const activeTools = hasActiveToolCalls(store.getChat(sessionId));
          const busy =
            runBusy(
              chatStatus,
              appStatus,
              pendingApprovals.length > 0,
              activeTools,
            ) || activeTools;
          // An approval nobody answers is the one state that never resolves on
          // its own, and the agent log is silent throughout it. Logged once per
          // run rather than per tick.
          pendingAtEnd = pendingApprovals.length;
          if (pendingApprovals.length > 0 && !approvalWaitLogged) {
            approvalWaitLogged = true;
            logRelayInfo(
              approvalWaitLine(
                pendingApprovals.length,
                pendingApprovals.map((a) => a.toolName),
              ),
            );
          }

          if (!queued && !busy) break;

          if (Date.now() - settleStart > SETTLE_TIMEOUT) {
            break;
          }

          if (!busy && queued) {
            const runtime = await import("../ai/store/chatRuntime");
            await runtime.flushSteer();
          }

          // Advance settle clock only after the work above. If the run is still
          // busy after a flush, the next iteration must still age toward the
          // timeout instead of resetting it forever.
          settleStart = Date.now();
        }

        // If run stopped due to step-cap, offer one-click continuation button.
        await sleep(signal, 1800);
        const stopReason =
          stopReasonSnapshot ??
          store.useChatStore.getState().agentMeta.stopReason;
        stopReasonAtEnd = stopReason;
        const statusAfterWait = store.useChatStore.getState().agentMeta.status;
        const stoppedByUser =
          store.useChatStore.getState().agentMeta.stoppedByUser;
        if (
          stopReason === "step-cap" &&
          statusAfterWait === "idle" &&
          !stoppedByUser
        ) {
          const currentRound =
            store.useChatStore.getState().agentMeta.runRound ?? 0;
          const { stepBudgetForRound } = await import("../ai/config");
          const nextBudget = stepBudgetForRound(currentRound + 1);
          await sendKeyboard(
            chatId,
            `Step limit reached (round ${currentRound + 1}). Continue to next round (${nextBudget} steps)?`,
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
        } else if (
          stopReason &&
          stopReason !== "step-cap" &&
          statusAfterWait === "idle" &&
          !stoppedByUser
        ) {
          await sendKeyboard(
            chatId,
            `Agent paused (${stopReason}). Choose an action below or send your next instruction:`,
            [
              [
                {
                  text: ">> Continue anyway",
                  callback_data: "resume:run",
                },
              ],
            ],
            signal,
          ).catch(() => {});
        }

        // Share any report/document file the agent previewed in this run.
        await sendReportFiles(
          chatId,
          store.getChat,
          sessionId,
          baseline,
          signal,
        );
      } finally {
        if (typingTimer) {
          clearInterval(typingTimer);
          typingTimer = null;
        }
        progressCtl.abort();
        if (progressCtrls.get(chatId) === progressCtl) {
          progressCtrls.delete(chatId);
        }
      }
    } finally {
      resumeMirror();
    }
  } catch (e) {
    if (signal.aborted) return;
    logRelayWarn(relayErrorLine(`run ${sessionIdForLog || "?"}`, e));
    await sendTelegram(
      chatId,
      `Error during run: ${e instanceof Error ? e.message : String(e)}`,
      signal,
    ).catch(() => {});
  } finally {
    // One line per relayed run, on every exit path. This is the line whose
    // absence made "the agent hangs without producing output" impossible to
    // confirm from the log.
    logRelayInfo(
      runOutcomeLine({
        sessionId: sessionIdForLog || "?",
        chatId,
        elapsedMs: Date.now() - startedAt,
        replies,
        sentChars,
        fallback: seenFallback,
        stopReason: stopReasonAtEnd,
        status: signal.aborted ? "aborted" : "settled",
        pendingApprovals: pendingAtEnd,
      }),
    );
  }
}

export async function dispatchAndStream(
  text: string,
  chatId: number,
  signal: AbortSignal,
  initialText?: string,
  mode: "task" | "question" = "task",
): Promise<void> {
  const runtime = await import("../ai/store/chatRuntime");
  await runAgentAndStream(
    () => runtime.sendMessage(text),
    chatId,
    signal,
    initialText,
    mode,
  );
}

/**
 * Resume a paused/capped run, bumping to the next step budget tier (25 -> 50 -> 100).
 */
export function startTelegramResume(chatId: number, signal: AbortSignal): void {
  // No pauseMirror here: runAgentAndStream pauses the mirror for the whole run
  // and releases it in its own finally. A bare pause on this path (which has
  // several early returns) left the counter permanently above zero, which
  // silently disabled Termigo -> Telegram mirroring for the rest of the session.
  void (async () => {
    try {
      if (isResumeOnCooldown(chatId)) {
        await sendTelegram(
          chatId,
          "Please wait a moment before continuing again.",
          signal,
        ).catch(() => {});
        return;
      }
      const store = await import("../ai/store/chatStore");
      const runtime = await import("../ai/store/chatRuntime");
      const sessionId = store.useChatStore.getState().activeSessionId;
      const pendingSteer =
        store.useChatStore.getState().steerQueue.pending.length > 0;
      if (pendingSteer) {
        await sendTelegram(
          chatId,
          "Ada pesan tertunda. Tunggu selesai, atau pakai /new untuk mulai baru.",
          signal,
        ).catch(() => {});
        return;
      }
      if (!sessionId) {
        await sendTelegram(chatId, "No active session to resume.", signal);
        return;
      }
      const chatStatus = sessionId
        ? (store.getChat(sessionId)?.status ?? "")
        : "";
      const appStatus = store.useChatStore.getState().agentMeta.status;
      const aqStore = await import("../ai/store/approvalQueueStore");
      const pendingApprovals = getPendingApprovals(
        sessionId,
        store,
        aqStore.useApprovalQueue,
      );
      if (pendingApprovals.length > 0) {
        const p = pendingApprovals[0];
        const prefix = p.source === "queue" ? "aq" : "ap";
        const countNotice =
          pendingApprovals.length > 1
            ? ` (1 of ${pendingApprovals.length})`
            : "";
        await sendKeyboard(
          chatId,
          `Action Approval Required${countNotice}:\nTool: ${p.toolName}\nTarget: ${p.summary || p.toolName}\n(Tap button below or reply /approve /deny)`,
          [
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
          ],
          signal,
        ).catch(() => {});
        return;
      }
      const meta = store.useChatStore.getState().agentMeta;
      const isPausedOnStepCap =
        meta.stopReason === "step-cap" &&
        !meta.stoppedByUser &&
        meta.status === "idle";
      const activeTools = hasActiveToolCalls(store.getChat(sessionId));
      const busy =
        !isPausedOnStepCap &&
        (runBusy(chatStatus, appStatus, false, activeTools) || activeTools);
      if (busy) {
        await sendTelegram(
          chatId,
          "Agent is still working. Wait for it to finish, or send /stop first.",
          signal,
        ).catch(() => {});
        return;
      }
      await sendTelegram(chatId, `Resuming...`, signal).catch(() => {});
      await sendTyping(chatId, signal).catch(() => {});
      await runAgentAndStream(() => runtime.resumeRun(), chatId, signal);
    } catch (e) {
      if (!signal.aborted) {
        await sendTelegram(
          chatId,
          `Error during resume: ${e instanceof Error ? e.message : String(e)}`,
          signal,
        ).catch(() => {});
      }
    }
  })();
}

/**
 * Dispatch a Telegram-initiated task with immediate synchronous mirror lock
 * and prompt tracking, preventing any race condition where the user's prompt
 * or resulting reply could be mirrored back to Telegram.
 */
export async function startTelegramDispatch(
  text: string,
  chatId: number,
  signal: AbortSignal,
  ackText: string,
  mode: "task" | "question" = "task",
): Promise<void> {
  try {
    const store = await import("../ai/store/chatStore");
    const runtime = await import("../ai/store/chatRuntime");
    const sessionId = store.useChatStore.getState().activeSessionId;
    const appStatus = store.useChatStore.getState().agentMeta.status;
    const chat = sessionId ? store.getChat(sessionId) : null;
    const chatStatus = chat?.status ?? "";
    const activeTools = hasActiveToolCalls(chat);
    const busy =
      runBusy(chatStatus, appStatus, false, activeTools) || activeTools;

    // A pending `ask_user` question is the one "busy" state where the user's
    // reply IS the answer. It is checked BEFORE the busy branch, because the
    // busy branch queued the text as a NEW task and the question then waited
    // forever: the run sat on the elicitation while the user's answers piled up
    // as future turns, which only `/stop` released. Observed in the field as
    // three text messages logged, no dispatch, then
    // "/stop" followed by "3 answer(s), 2959ch sent" for the 4m58s old run.
    // Typing is the natural reply; the buttons are an option, not the only way.
    const elStore = await import("../ai/store/elicitationStore");
    const pendingQuestion = elStore.useElicitationStore.getState().pending[0];
    if (pendingQuestion) {
      const answer = matchElicitationAnswer(text, pendingQuestion.options);
      recordTelegramText(text);
      elStore.useElicitationStore.getState().answer(pendingQuestion.id, answer);
      logRelayInfo(
        `answered pending question ${pendingQuestion.id} from free text (${text.length}ch)`,
      );
      await sendTelegram(chatId, `▸ ${answer}`, signal).catch(() => {});
      return;
    }

    const aqStore = await import("../ai/store/approvalQueueStore");
    const pendingApprovals = sessionId
      ? getPendingApprovals(sessionId, store, aqStore.useApprovalQueue)
      : [];
    if (pendingApprovals.length > 0) {
      const lower = text.trim().toLowerCase();
      if (
        lower === "approve" ||
        lower === "yes" ||
        lower === "ya" ||
        lower === "ok" ||
        lower === "lanjut" ||
        lower === "setuju" ||
        lower === "izinkan"
      ) {
        recordTelegramText(text);
        for (const p of pendingApprovals) {
          store.useChatStore.getState().respondToApproval(p.id, true);
          aqStore.useApprovalQueue.getState().respond([p.id], true);
        }
        await sendTelegram(
          chatId,
          `Approved ${pendingApprovals.length} pending action(s).`,
          signal,
        ).catch(() => {});
        await sendTyping(chatId, signal).catch(() => {});
        return;
      }
      if (
        lower === "deny" ||
        lower === "tolak" ||
        lower === "jangan" ||
        lower === "no" ||
        lower === "tidak"
      ) {
        recordTelegramText(text);
        for (const p of pendingApprovals) {
          store.useChatStore.getState().respondToApproval(p.id, false);
          aqStore.useApprovalQueue.getState().respond([p.id], false);
        }
        await sendTelegram(
          chatId,
          `Denied ${pendingApprovals.length} pending action(s).`,
          signal,
        ).catch(() => {});
        return;
      }
    }

    if (busy) {
      recordTelegramText(text);
      await sendTelegram(
        chatId,
        "The agent is busy. Your request will be processed shortly.",
        signal,
      ).catch(() => {});
      await runtime.sendMessage(text);
      return;
    }

    // Clean up previous finished progress message if any so it disappears on new task start
    const prevDoneMsgId = lastFinishedProgressMessageIds.get(chatId);
    if (prevDoneMsgId) {
      lastFinishedProgressMessageIds.delete(chatId);
      void deleteTelegramMessage(chatId, prevDoneMsgId);
    }

    pauseMirror();
    recordTelegramText(text);
    try {
      await sendTyping(chatId, signal).catch(() => {});
      await dispatchAndStream(text, chatId, signal, ackText, mode);
    } finally {
      resumeMirror();
    }
  } catch (e) {
    if (!signal.aborted) {
      await sendTelegram(
        chatId,
        `Error during run: ${e instanceof Error ? e.message : String(e)}`,
        signal,
      ).catch(() => {});
    }
  }
}
