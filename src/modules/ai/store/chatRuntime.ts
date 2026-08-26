import { Chat, type UIMessage } from "@ai-sdk/react";
import { info as logInfo } from "@tauri-apps/plugin-log";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import {
  getModel,
  providerNeedsKey,
  stepBudgetForRound,
  type ModelId,
} from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSessionDirectiveStore } from "./sessionDirectiveStore";
import { BUILTIN_AGENTS } from "../lib/agents";
import { useAgentsStore } from "./agentsStore";
import { usePlanStore } from "./planStore";
import { createContextAwareTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";
import {
  chats,
  getActiveProviderKey,
  seedMessages,
  setSessionLeftHandler,
  touchChat,
  useChatStore,
} from "./chatStore";
import { buildLanguageModel } from "../lib/agent";
import { dayKey, recordRunCost } from "../lib/costLedger";
import { fireHooksForEvent, makeRunId } from "../lib/hooksRunner";
import { sweepSessionMemory } from "../lib/memorySweep";
import {
  flush,
  previewOf,
  RESUME_PROMPT,
  submitAction,
  type SteerPart,
} from "../lib/steer";

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
    openPreview: (url) => useChatStore.getState().live.openPreview(url),
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
    browserUrl: (instance) =>
      useChatStore.getState().live.browserUrl(instance),
    browserClose: (instance) =>
      useChatStore.getState().live.browserClose(instance),
    browserList: () => useChatStore.getState().live.browserList(),
    spawnAgent: (prompt) =>
      useChatStore.getState().live.spawnManagedAgent(prompt, sessionId),
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
      return {
        cwd: live.getCwd(),
        terminalPrivate: live.isActiveTerminalPrivate(),
        workspaceRoot: live.getWorkspaceRoot(),
        activeFile: live.getActiveFile(),
        goal: directives.getGoal(sessionId),
        schedules: directives.getSchedules(sessionId),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    getStepBudget: () =>
      stepBudgetForRound(useChatStore.getState().agentMeta.runRound),
    getCostBudgetUsd: () =>
      usePreferencesStore.getState().costBudgetUsd,
    getCostDailyBudgetUsd: () =>
      usePreferencesStore.getState().costDailyBudgetUsd,
    getCaptureDebug: () =>
      usePreferencesStore.getState().debugCaptureEnabled,
    getAutoCheckpoint: () =>
      usePreferencesStore.getState().autoCheckpoint,
    getOpenaiCompatibleModelId: () =>
      usePreferencesStore.getState().openaiCompatibleModelId,
    getOpenaiCompatibleContextLimit: () =>
      usePreferencesStore.getState().openaiCompatibleContextLimit,
    getOpenrouterModelId: () =>
      usePreferencesStore.getState().openrouterModelId,
    getCustomEndpoints: () => usePreferencesStore.getState().customEndpoints,
    getCustomEndpointKeys: () => useChatStore.getState().customEndpointKeys,
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
      const hooksConfig = (useChatStore.getState().agentMeta as { hooksConfig?: import("../lib/hooks").HooksConfig }).hooksConfig;
      if (hooksConfig) {
        void fireHooksForEvent(hooksConfig, "Stop", null, {
          stopReason: info.stopReason,
          finishReason: info.finishReason,
          metrics: info.metrics,
        }, {
          getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
          getCwd: () => useChatStore.getState().live.getCwd(),
          makeRunId: () => (useChatStore.getState().agentMeta as { runId?: string }).runId ?? makeRunId(sessionId),
        }).catch(() => {});
      }
    },
    onUsage: (delta) => {
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
      useChatStore.getState().patchAgentMeta({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
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
  const c = getOrCreateChat(sessionId);
  const action = submitAction(c.status, parts.length > 0);
  logInfo(`[ai] sendParts: session=${sessionId} status=${c.status} action=${action}`);
  switch (action) {
    case "ignore":
      return false;
    case "queue":
      useChatStore
        .getState()
        .queueSteer({ preview: previewOf(parts), parts });
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
  const out = flush(store.steerQueue);
  if (!out) return false;
  // Clear before awaiting: two composers can both observe the run settle, and
  // a queue still populated across the await would send the same text twice.
  store.clearSteer();
  const sessionId = store.activeSessionId;
  if (!sessionId) return false;
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
