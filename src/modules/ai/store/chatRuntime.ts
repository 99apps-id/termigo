import { usePreferencesStore } from "@/modules/settings/preferences";
import { Chat, type UIMessage } from "@ai-sdk/react";
import { info as logInfo } from "@tauri-apps/plugin-log";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import {
  getModel,
  type ModelId,
  providerNeedsKey,
  stepBudgetForRound,
} from "../config";
import { buildLanguageModel } from "../lib/agent";
import { BUILTIN_AGENTS } from "../lib/agents";
import {
  isContextOverflowError,
  noteSuccessfulRequest,
  recordContextOverflow,
} from "../lib/contextLimitLearning";
import { dayKey, recordRunCost } from "../lib/costLedger";
import { humanizeModelError } from "../lib/errorMessage";
import {
  isConnectivityError,
  isQuotaError,
  isRateLimitError,
} from "../lib/errors";
import { fireHooksForEvent, makeRunId } from "../lib/hooksRunner";
import { sweepSessionMemory } from "../lib/memorySweep";
import {
  flushOne,
  previewOf,
  RESUME_PROMPT,
  type SteerPart,
  submitAction,
} from "../lib/steer";
import { createContextAwareTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";
import { useAgentsStore } from "./agentsStore";
import {
  chats,
  getActiveProviderKey,
  seedMessages,
  setSessionLeftHandler,
  touchChat,
  useChatStore,
} from "./chatStore";
import { usePlanStore } from "./planStore";
import { useSessionDirectiveStore } from "./sessionDirectiveStore";
import { useTodosStore } from "./todoStore";

// How close a context-overflow auto-resume may follow the previous one, per
// session. Prevents a run that cannot ever be compacted under the window (e.g.
// the system prompt + tool schemas alone exceed it) from looping forever: the
// first overflow retries automatically, a second one within this window falls
// back to the manual "Try again" button.
const OVERFLOW_AUTO_RESUME_MS = 60_000;
const overflowAutoResumeAt = new Map<string, number>();

// Sessions the user has explicitly stopped since the last user-initiated send.
// `Chat.stop()` aborts the in-flight round, but the Chat may still auto-continue
// to the next tool round via `sendAutomaticallyWhen` (or because the stream
// completed normally before the stop landed). The latch suppresses that
// continuation so a pressed Stop actually ends the loop. It is cleared on a
// fresh user send / resume / queued-correction flush.
const stopLatch = new Set<string>();

// Connectivity recovery: when the provider is unreachable, keep the run
// resumable and resume it automatically once the network is back, so an
// internet blip does not kill a long agentic task. Quota / rate-limit errors are
// recoverable too but have no reliable event to watch for — the user tops up or
// waits, then clicks "Try again" (their work is preserved).
const pendingReconnectSessions = new Set<string>();
let onlineListenerRegistered = false;
function ensureOnlineListener(): void {
  if (onlineListenerRegistered) return;
  onlineListenerRegistered = true;
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => {
    const active = useChatStore.getState().activeSessionId;
    if (active && pendingReconnectSessions.has(active)) {
      pendingReconnectSessions.delete(active);
      useChatStore.getState().patchAgentMeta({
        status: "thinking",
        error: null,
        stopReason: null,
      });
      void resumeRun().catch(() => {
        useChatStore.getState().patchAgentMeta({
          status: "error",
          error:
            "Still can't reach the provider. Check your connection and click Try again.",
        });
      });
    }
  });
}

function makeChat(sessionId: string): Chat<UIMessage> {
  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getRemoteSession: () => useChatStore.getState().live.getRemoteSession(),
    getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
    getTerminalContext: () => useChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useChatStore.getState().live.injectIntoActivePty(text),
    openPreview: (url, browserInstance) =>
      useChatStore.getState().live.openPreview(url, browserInstance),
    openCanvas: (html, title) =>
      useChatStore.getState().live.openCanvas(html, title),
    browserOpen: (instance, url) =>
      useChatStore.getState().live.browserOpen(instance, url),
    browserNavigate: (instance, url) =>
      useChatStore.getState().live.browserNavigate(instance, url),
    browserBack: (instance) =>
      useChatStore.getState().live.browserBack(instance),
    browserForward: (instance) =>
      useChatStore.getState().live.browserForward(instance),
    browserReload: (instance) =>
      useChatStore.getState().live.browserReload(instance),
    browserExtract: (instance) =>
      useChatStore.getState().live.browserExtract(instance),
    browserEval: (instance, js) =>
      useChatStore.getState().live.browserEval(instance, js),
    browserScreenshot: (instance) =>
      useChatStore.getState().live.browserScreenshot(instance),
    browserConsole: (instance) =>
      useChatStore.getState().live.browserConsole(instance),
    browserUrl: (instance) => useChatStore.getState().live.browserUrl(instance),
    browserClose: (instance) =>
      useChatStore.getState().live.browserClose(instance),
    browserList: () => useChatStore.getState().live.browserList(),
    spawnAgent: (prompt, agent) =>
      useChatStore.getState().live.spawnManagedAgent(prompt, sessionId, agent),
    readAgentOutput: (leafId) =>
      useChatStore.getState().live.readLeafBuffer(leafId),
    readCache,
    getSessionId: () => sessionId,
  };

  const transport = createContextAwareTransport({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModelId: () => useChatStore.getState().selectedModelId,
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getAgentPersona: () => {
      const { activeId, customAgents } = useAgentsStore.getState();
      const all = [...BUILTIN_AGENTS, ...customAgents];
      const a = all.find((x) => x.id === activeId) ?? BUILTIN_AGENTS[0];
      return { name: a.name, instructions: a.instructions };
    },
    getLive: () => {
      const live = useChatStore.getState().live;
      const directives = useSessionDirectiveStore.getState();
      const todos = useTodosStore.getState().bySession[sessionId]?.items ?? [];
      return {
        cwd: live.getCwd(),
        terminalPrivate: live.isActiveTerminalPrivate(),
        workspaceRoot: live.getWorkspaceRoot(),
        activeFile: live.getActiveFile(),
        goal: directives.getGoal(sessionId),
        schedules: directives.getSchedules(sessionId),
        todos: todos.map((t) => ({ title: t.title, status: t.status })),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    getStepBudget: () =>
      stepBudgetForRound(useChatStore.getState().agentMeta.runRound),
    getCostBudgetUsd: () => usePreferencesStore.getState().costBudgetUsd,
    getCostDailyBudgetUsd: () =>
      usePreferencesStore.getState().costDailyBudgetUsd,
    getCaptureDebug: () => usePreferencesStore.getState().debugCaptureEnabled,
    getAutoCheckpoint: () => usePreferencesStore.getState().autoCheckpoint,
    getOpenaiCompatibleModelId: () =>
      usePreferencesStore.getState().openaiCompatibleModelId,
    getOpenaiCompatibleContextLimit: () =>
      usePreferencesStore.getState().openaiCompatibleContextLimit,
    getOpenrouterModelId: () =>
      usePreferencesStore.getState().openrouterModelId,
    getCustomEndpoints: () => usePreferencesStore.getState().customEndpoints,
    getCustomEndpointKeys: () => useChatStore.getState().customEndpointKeys,
    // Queue size, so the run can yield at the next step when a NEW task is typed
    // while it works (see getSteerCount in the transport).
    getSteerCount: () => useChatStore.getState().steerQueue.pending.length,
    onStep: (step) => {
      useChatStore.getState().patchAgentMeta({ step });
    },
    onCompact: (info) => {
      useChatStore.getState().patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onRemember: (info) => {
      useChatStore.getState().patchAgentMeta({
        memoryNotice: { fact: info.fact, at: Date.now() },
      });
    },
    onFinishMeta: (info) => {
      useChatStore.getState().patchAgentMeta({ stopReason: info.stopReason });
      useChatStore.getState().setLastRun(info.metrics);
      useChatStore.getState().syncRunMeta();
      // Remember what this run cost. The estimate only exists for priced
      // models, so unknown ones record nothing rather than a false zero.
      const m = info.metrics;
      if (m.estimatedCostUsd != null && m.estimatedCostUsd > 0) {
        void recordRunCost({
          at: m.at,
          day: dayKey(m.at),
          modelId: m.modelId,
          provider: m.provider,
          workspaceRoot: useChatStore.getState().live.getWorkspaceRoot(),
          costUsd: m.estimatedCostUsd,
          inputTokens: m.tokens.input,
          outputTokens: m.tokens.output,
          cachedTokens: m.tokens.cached,
        }).catch(() => {});
      }
      // Fire Stop hooks after the run finishes. This is the only place the
      // agent knows the run is truly over, so it is the only reliable place
      // to signal completion to external tooling.
      const hooksConfig = (
        useChatStore.getState().agentMeta as {
          hooksConfig?: import("../lib/hooks").HooksConfig;
        }
      ).hooksConfig;
      if (hooksConfig) {
        void fireHooksForEvent(
          hooksConfig,
          "Stop",
          null,
          {
            stopReason: info.stopReason,
            finishReason: info.finishReason,
            metrics: info.metrics,
          },
          {
            getWorkspaceRoot: () =>
              useChatStore.getState().live.getWorkspaceRoot(),
            getCwd: () => useChatStore.getState().live.getCwd(),
            makeRunId: () =>
              (useChatStore.getState().agentMeta as { runId?: string }).runId ??
              makeRunId(sessionId),
          },
        ).catch(() => {});
      }
    },
    onUsage: (delta) => {
      // A request that came back with real headroom lets the learned budget
      // scale relax, so one overflow does not over-compact the model forever.
      noteSuccessfulRequest(
        useChatStore.getState().selectedModelId,
        delta.lastInputTokens,
      );
      const cur = useChatStore.getState().agentMeta.tokens;
      useChatStore.getState().patchAgentMeta({
        tokens: {
          inputTokens: cur.inputTokens + delta.inputTokens,
          outputTokens: cur.outputTokens + delta.outputTokens,
          cachedInputTokens: cur.cachedInputTokens + delta.cachedInputTokens,
        },
        lastInputTokens: delta.lastInputTokens,
        lastCachedTokens: delta.lastCachedTokens,
      });
    },
  }) as unknown as ChatTransport<UIMessage>;

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    // The SDK's `stop()` aborts the in-flight round but the Chat still
    // auto-continues to the next tool round through this predicate. A user
    // stop must end the loop, so suppress the auto-continue while a stop is
    // latched for this session (clear see `stopLatch`).
    sendAutomaticallyWhen: (args) =>
      !stopLatch.has(sessionId) &&
      lastAssistantMessageIsCompleteWithApprovalResponses(args),
    onError: (e) => {
      const raw = e instanceof Error ? e.message : String(e);
      // A user-pressed Stop surfaces here as an AbortError when it lands before
      // the model call (during the checkpoint / context phase). That is not a
      // failure — settle quietly as a stop instead of a red error banner.
      const aborted =
        (e as { name?: string })?.name === "AbortError" ||
        /\baborted\b/i.test(raw);
      if (aborted) {
        useChatStore.getState().patchAgentMeta({
          status: "idle",
          error: null,
          stoppedByUser: true,
        });
        return;
      }
      // Learn the model's real context window from an overflow, then CONTINUE
      // the same run automatically so a long agentic task does not stop the
      // moment the transcript outgrows the window: the retry compacts harder
      // and lands under the cap. The manual "Try again" button stays for when
      // even the auto-resume cannot fit, or the throttle prevents a repeat.
      if (isContextOverflowError(raw)) {
        recordContextOverflow(useChatStore.getState().selectedModelId, raw);
        const sessionId = useChatStore.getState().activeSessionId;
        const now = Date.now();
        const lastAuto = overflowAutoResumeAt.get(sessionId ?? "") ?? 0;
        if (sessionId && now - lastAuto > OVERFLOW_AUTO_RESUME_MS) {
          overflowAutoResumeAt.set(sessionId, now);
          useChatStore.getState().patchAgentMeta({
            status: "thinking",
            error: null,
            stopReason: null,
          });
          setTimeout(() => {
            void resumeRun().catch(() => {
              useChatStore.getState().patchAgentMeta({
                status: "error",
                error: "The automatic retry could not start. Try again.",
              });
            });
          }, 0);
          return;
        }
      }
      // A connectivity loss is recoverable once the network is back. Mark the
      // run as resumable and let the `online` listener (or "Try again") pick it
      // up — the task/todo state is preserved.
      if (isConnectivityError(raw)) {
        const sessionId = useChatStore.getState().activeSessionId;
        if (sessionId) pendingReconnectSessions.add(sessionId);
        ensureOnlineListener();
        useChatStore.getState().patchAgentMeta({
          status: "error",
          error:
            "Connection to the provider was lost. Your run is preserved — it resumes automatically when you're back online, or click Try again.",
        });
        return;
      }
      // Quota / credits exhausted or a rate limit: recoverable once the user
      // tops up or waits. The run stays resumable via "Try again".
      if (isQuotaError(raw) || isRateLimitError(raw)) {
        useChatStore.getState().patchAgentMeta({
          status: "error",
          error: isQuotaError(raw)
            ? "The provider reports your API quota or credits are exhausted. Top up and click Try again — your work is preserved."
            : "Rate limit reached. Wait a moment and click Try again — your work is preserved.",
        });
        return;
      }
      useChatStore.getState().patchAgentMeta({
        status: "error",
        error: humanizeModelError(raw),
      });
    },
  });
}

export function getOrCreateChat(sessionId: string): Chat<UIMessage> {
  const existing = chats.get(sessionId);
  if (existing) {
    touchChat(sessionId, existing);
    return existing;
  }
  const c = makeChat(sessionId);
  touchChat(sessionId, c);
  return c;
}

/**
 * Send, or queue when a run is already in flight.
 *
 * Submitting mid-run used to hand a second message to a `Chat` that was still
 * streaming the first. Now it is held and delivered by `flushSteer` when the
 * run settles, so a correction typed at second 3 of a 30-second run is not lost
 * and does not race the request it was meant to adjust.
 *
 * Returns whether anything was accepted; the caller clears its input either
 * way, because from the user's side the message has been taken.
 */
export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  if (
    providerNeedsKey(getModel(state.selectedModelId as ModelId).provider) &&
    !getActiveProviderKey()
  )
    return false;

  return sendParts(sessionId, [{ type: "text", text }]);
}

/**
 * Send composed parts, or queue them when a run is already in flight.
 *
 * Parts rather than text so an image or file attached mid-run survives the
 * wait; queuing only the text would drop it without saying so.
 */
export async function sendParts(
  sessionId: string,
  parts: readonly SteerPart[],
): Promise<boolean> {
  // A fresh user message supersedes a prior stop, so let it run.
  stopLatch.delete(sessionId);
  const c = getOrCreateChat(sessionId);
  // After an error the run is not busy, but the SDK status can look stale
  // (still "submitted"), which would QUEUE the resume instead of sending it and
  // leave "Try again" doing nothing. Key off the app's error state so a resume
  // after a failed run always goes out.
  const errored = useChatStore.getState().agentMeta.status === "error";
  const action = errored
    ? parts.length > 0
      ? "send"
      : "ignore"
    : submitAction(c.status, parts.length > 0);
  if (errored) pendingReconnectSessions.delete(sessionId);
  logInfo(
    `[ai] sendParts: session=${sessionId} status=${c.status} action=${action}`,
  );
  switch (action) {
    case "ignore":
      return false;
    case "queue":
      useChatStore.getState().queueSteer({ preview: previewOf(parts), parts });
      return true;
    case "send":
      await c.sendMessage({ role: "user", parts } as Parameters<
        typeof c.sendMessage
      >[0]);
      return true;
  }
}

/**
 * Deliver anything queued during the last run.
 *
 * Called when a run settles, including after a stop: text typed while the agent
 * was working is a correction, and abandoning it because the user also hit stop
 * would silently discard something they explicitly wrote.
 */
let flushing = false;

export async function flushSteer(): Promise<boolean> {
  // Both composers can observe the same settle; the flag makes the second a
  // no-op rather than a duplicate turn.
  if (flushing) return false;
  const store = useChatStore.getState();
  const out = flushOne(store.steerQueue);
  if (!out) return false;
  // Deliver only the OLDEST queued task and leave the rest queued: tasks are
  // worked one at a time, each as its own turn (the Claude queue model). Pop it
  // before awaiting so a second observer of the same settle cannot resend it;
  // the composer re-runs flushSteer on the next settle to pick up the next one.
  store.cancelSteer(0);
  const sessionId = store.activeSessionId;
  if (!sessionId) return false;
  // A queued correction is the user's own input, so it supersedes a stop.
  stopLatch.delete(sessionId);
  // A run that yielded to this queued task set stopReason "steered"; clear it so
  // no stale "Continue" prompt lingers as the queued task takes over.
  store.patchAgentMeta({ stopReason: null, stoppedByUser: false });
  flushing = true;
  try {
    const c = getOrCreateChat(sessionId);
    await c.sendMessage({ role: "user", parts: out.parts } as Parameters<
      typeof c.sendMessage
    >[0]);
  } finally {
    flushing = false;
  }
  return true;
}

/** Pick the work back up after the user stopped it. */
export async function resumeRun(): Promise<boolean> {
  const sessionId = useChatStore.getState().activeSessionId;
  // A manual resume supersedes any pending reconnect auto-resume for this
  // session, so the `online` listener does not fire a second one.
  if (sessionId) pendingReconnectSessions.delete(sessionId);
  // Continuing is the signal that the task is heavier than one round, so the
  // next round gets the next budget tier. Raised before the send so the run
  // reads the new value.
  const round = useChatStore.getState().agentMeta.runRound;
  useChatStore.getState().patchAgentMeta({ runRound: round + 1 });
  return sendMessage(RESUME_PROMPT);
}

/** Stop the current run, then deliver anything the user queued while it ran. */
export async function stopRun(): Promise<void> {
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) return;
  // Latch before aborting so the Chat's auto-continue (which may fire from the
  // round that just completed) is suppressed even if `stop()` returns early
  // because it landed between rounds.
  stopLatch.add(sessionId);
  await chats.get(sessionId)?.stop();
  // Remembered so the transcript can offer "Continue" after a stop, the same
  // way it does after the step cap. Without it a stop is a dead end.
  useChatStore.getState().patchAgentMeta({ stoppedByUser: true });
  useChatStore.getState().syncRunMeta();
  // The stop leaves `status` settled, so the queued text sends as a fresh turn
  // rather than piling onto the run that was just abandoned.
  await flushSteer();
}

// Summarise a session the user has left and append anything durable to
// .termigo/memory.md. Registered here because this is the one place that can
// reach the model, the workspace root and the approval mode at once.
//
// Fire-and-forget on purpose: the user has already moved on, and a failed
// sweep must not surface as an error in the session they just opened.
setSessionLeftHandler((_sessionId, messages) => {
  void (async () => {
    const state = useChatStore.getState();
    const workspaceRoot = state.live.getWorkspaceRoot();
    if (!workspaceRoot) return;
    const mode = usePreferencesStore.getState().agentApprovalMode;
    try {
      const model = await buildLanguageModel(
        getModel(state.selectedModelId as ModelId).provider,
        state.apiKeys,
        state.selectedModelId,
      );
      await sweepSessionMemory({ model, workspaceRoot, messages, mode });
    } catch {
      // No model configured, or the call failed. Memory is best-effort.
    }
  })();
});
