import { usePreferencesStore } from "@/modules/settings/preferences";
import { Chat, type UIMessage } from "@ai-sdk/react";
import { info as logInfo } from "@tauri-apps/plugin-log";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { toast } from "sonner";
import {
  getModel,
  isCompatModelId,
  type ModelId,
  type ProviderId,
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
// session, and how many it may attempt before giving up. A run that cannot
// ever be compacted under the window (e.g. the system prompt + tool schemas
// alone exceed it) would otherwise loop forever, so we cap the retries; but a
// single overflow should not hard-stop the chat, because each retry compacts
// harder (the learned scale shrinks), so a long but recoverable transcript
// keeps going instead of dead-ending on "Request failed".
const OVERFLOW_AUTO_RESUME_MS = 30_000;
const MAX_OVERFLOW_RESUMES = 3;
const overflowAutoResumeAt = new Map<string, number>();
const overflowAutoResumeCount = new Map<string, number>();

// Cap the agentic loop in ROUNDS, not per-round steps. The step budget (25)
// resets every round, so a model that does a few tool calls per round and never
// summarises can loop across rounds forever while each round looks "within
// budget". This cap is the aggregate guard: once a run has made this many model
// calls without finishing, the next round is refused (the transcript offers
// Continue, which resets the per-run counter). 24 is generous — real tasks
// rarely need it, and a genuinely stuck run is stopped before it burns tokens.
const MAX_LOOP_ROUNDS = 24;

// Pin the workspace the agent works on for the whole run. The toolContext reads
// these instead of the live (mutable) context, so switching tabs, opening
// another folder or connecting an SSH session mid-run cannot silently redirect
// the agent to a different directory or host — which would fail its tool calls
// and make it loop. Refreshed only when the user submits a fresh task.
type RunAnchor = {
  cwd: string | null;
  root: string | null;
  remote: import("../tools/context").RemoteFsSession | null;
};
const runAnchor = new Map<string, RunAnchor>();

// Sessions the user has explicitly stopped since the last user-initiated send.
// `Chat.stop()` aborts the in-flight round, but the Chat may still auto-continue
// to the next tool round via `sendAutomaticallyWhen` (or because the stream
// completed normally before the stop landed). The latch suppresses that
// continuation so a pressed Stop actually ends the loop. It is cleared on a
// fresh user send / resume / queued-correction flush.
const stopLatch = new Set<string>();

// Throttle the "Round N started" toast so a fast agentic loop cannot spam the
// screen. Only the first round of a run toasts (round 2+, since round 1 is the
// initial send), and at most once per 3s.
let lastRoundToastAt = 0;
let lastRoundToast = 0;
function maybeToastRound(round: number): void {
  if (round < 2) return;
  const now = Date.now();
  if (now - lastRoundToastAt < 3000 && round === lastRoundToast) return;
  lastRoundToastAt = now;
  lastRoundToast = round;
  // Never let a toast failure break the run — this fires at the start of every
  // round and a render/notification error must not stop the agent.
  try {
    toast.info(`Agent round ${round}`, {
      description: "Starting a new model call — the run is still going.",
    });
  } catch {
    // ignore
  }
}

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
  // Set when the loop cap (not the user) refuses a round, so the AbortError it
  // surfaces is settled as an automatic stop rather than a "user stopped".
  let loopCapRefused = false;
  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: () =>
      runAnchor.get(sessionId)?.cwd ?? useChatStore.getState().live.getCwd(),
    getRemoteSession: () =>
      runAnchor.get(sessionId)?.remote ??
      useChatStore.getState().live.getRemoteSession(),
    getWorkspaceRoot: () =>
      runAnchor.get(sessionId)?.root ??
      useChatStore.getState().live.getWorkspaceRoot(),
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
    onRoundStart: () => {
      // Fires once per agentic-loop round (each sendMessages) so the UI can
      // show "Round N · step X" and a user can tell the run is still going.
      const next = useChatStore.getState().agentMeta.round + 1;
      useChatStore.getState().patchAgentMeta({ round: next });
      maybeToastRound(next);
    },
    // Refuse the SDK's next auto-continue round when a Stop was latched or the
    // agent has looped too long. The latch / round counter is cleared on the
    // user's next send (sendParts/flushSteer), so a fresh message starts
    // normally. Keeping this here (instead of wrapping `sendAutomaticallyWhen`)
    // leaves the Chat's own continuation semantics untouched.
    shouldRefuseRun: (id) => {
      if (stopLatch.has(id)) return true;
      // Aggregate loop cap: stop a run that keeps calling tools round after
      // round without producing a final summary.
      if (useChatStore.getState().agentMeta.round >= MAX_LOOP_ROUNDS) {
        loopCapRefused = true;
        useChatStore.getState().patchAgentMeta({
          stopReason: "step-cap",
          stoppedByUser: false,
        });
        return true;
      }
      return false;
    },
    onStep: (step) => {
      useChatStore.getState().patchAgentMeta({ step });
    },
    onCompact: (info) => {
      useChatStore.getState().patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onPrune: (info) => {
      useChatStore.getState().patchAgentMeta({
        pruneNotice: { prunedMessages: info.prunedMessages, at: Date.now() },
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
      // A run that actually finished (not an overflow error) means the request
      // fit this time — allow the session to auto-resume on a future overflow
      // instead of exhausting its retry budget permanently.
      const fr = info.finishReason ?? "";
      if (fr && fr !== "error") overflowAutoResumeCount.delete(sessionId);
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
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      const raw = e instanceof Error ? e.message : String(e);
      // A user-pressed Stop surfaces here as an AbortError when it lands before
      // the model call (during the checkpoint / context phase). That is not a
      // failure — settle quietly as a stop instead of a red error banner.
      const aborted =
        (e as { name?: string })?.name === "AbortError" ||
        /\baborted\b/i.test(raw);
      if (aborted) {
        // A loop-cap refusal is an automatic stop, not a user stop.
        if (loopCapRefused) {
          loopCapRefused = false;
          useChatStore.getState().patchAgentMeta({
            status: "idle",
            error: null,
            stoppedByUser: false,
          });
          useChatStore.getState().syncRunMeta();
          return;
        }
        useChatStore.getState().patchAgentMeta({
          status: "idle",
          error: null,
          stoppedByUser: true,
        });
        useChatStore.getState().syncRunMeta();
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
        const attempts = overflowAutoResumeCount.get(sessionId ?? "") ?? 0;
        if (
          sessionId &&
          attempts < MAX_OVERFLOW_RESUMES &&
          now - lastAuto > OVERFLOW_AUTO_RESUME_MS
        ) {
          overflowAutoResumeAt.set(sessionId, now);
          overflowAutoResumeCount.set(sessionId, attempts + 1);
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
              useChatStore.getState().syncRunMeta();
            });
          }, 0);
          return;
        }
      }
      // A connectivity loss is recoverable once the network is back. Mark the
      // run as resumable and let the `online` listener (or "Try again") pick it
      // up — the task/todo state is preserved. The run is no longer "in flight"
      // (it errored), so clear the in-flight marker: a later restart must not
      // read it as an interrupted run, and resume re-marks it.
      if (isConnectivityError(raw)) {
        const sessionId = useChatStore.getState().activeSessionId;
        if (sessionId) pendingReconnectSessions.add(sessionId);
        ensureOnlineListener();
        useChatStore.getState().patchAgentMeta({
          status: "error",
          error:
            "Connection to the provider was lost. Your run is preserved — it resumes automatically when you're back online, or click Try again.",
        });
        useChatStore.getState().syncRunMeta();
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
        useChatStore.getState().syncRunMeta();
        return;
      }
      useChatStore.getState().patchAgentMeta({
        status: "error",
        error: humanizeModelError(raw),
      });
      useChatStore.getState().syncRunMeta();
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
/** Provider for a model id, resolving user-defined OpenAI-compatible endpoints.
 *  `getModel` only knows built-in models and throws for a `compat-*` id (e.g.
 *  StepFun), so the send path must use this instead. */
function providerForModel(modelId: string): ProviderId {
  if (isCompatModelId(modelId)) return "openai-compatible";
  return getModel(modelId as ModelId).provider;
}

export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  if (
    providerNeedsKey(providerForModel(state.selectedModelId)) &&
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
      // A fresh user turn resets the loop-round counter; the first model call
      // of this turn will bump it to 1.
      useChatStore.getState().patchAgentMeta({ round: 0 });
      // Pin the workspace anchor for the whole run (see runAnchor above). The
      // auto-continue rounds that follow do NOT go through sendParts, so the
      // agent stays on the folder / host the user was looking at when they sent
      // the task, even if they switch elsewhere mid-run.
      {
        const live = useChatStore.getState().live;
        runAnchor.set(sessionId, {
          cwd: live.getCwd(),
          root: live.getWorkspaceRoot(),
          remote: live.getRemoteSession(),
        });
      }
      // Persist that the run is now in flight, so a restart mid-run can offer
      // "Resume" rather than silently losing it.
      useChatStore.getState().markRunStarted();
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
  // A fresh user turn resets the loop-round counter (see sendParts).
  store.patchAgentMeta({ round: 0 });
  // A run that yielded to this queued task set stopReason "steered"; clear it so
  // no stale "Continue" prompt lingers as the queued task takes over.
  store.patchAgentMeta({ stopReason: null, stoppedByUser: false });
  // A queued task starts a fresh run, so mark it in flight for restart recovery.
  store.markRunStarted();
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
        providerForModel(state.selectedModelId),
        state.apiKeys,
        state.selectedModelId,
      );
      await sweepSessionMemory({ model, workspaceRoot, messages, mode });
    } catch {
      // No model configured, or the call failed. Memory is best-effort.
    }
  })();
});
