import { usePreferencesStore } from "@/modules/settings/preferences";
import { info as logInfo } from "@tauri-apps/plugin-log";
import { generateText, stepCountIs } from "ai";
import { subagentModelExceedsBudget } from "../config";
import {
  buildConfiguredLanguageModel,
  noErrorProgress,
  noProgressStop,
  noToolRepetition,
} from "../lib/agent";
import { buildExtensionTools } from "../lib/extensionTools";
import { getProfile } from "../lib/harnessProfile";
import { activeProfileIdFor } from "../lib/harnessProfileStore";
import type { ProviderKeys } from "../lib/keyring";
import { repairToolCall } from "../lib/repairToolCall";
import { subagentMadeProgress } from "../lib/subagentProgress";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "../tools/context";
import { buildTools } from "../tools/tools";
import { buildAgentTools, buildSubagentSpec } from "./agentFactory";
import { SUBAGENTS, type SubagentType } from "./registry";
import {
  type AnyTool,
  type DenialBreaker,
  gate,
  newFilesOnly,
  subagentToolNeedsGate,
  WRITE_FILE,
} from "./subagentGating";
import { SUMMARY_TIMEOUT_MS, synthesizeSummary } from "./subagentSummary";

export { subagentToolNeedsGate };

/**
 * Max subagent nesting depth. A subagent may spawn further subagents up to this
 * depth, then the spawn tools are withheld (BatikCode parity, instead of a flat
 * "subagents can never spawn" rule). The main agent is depth 0.
 */
export const MAX_SUBAGENT_DEPTH = 3;

/**
 * Effective nesting cap. Reads the user's `subagentMaxDepth` preference
 * (clamped to 1..5), so the cap is tunable rather than a hard constant; falls
 * back to `MAX_SUBAGENT_DEPTH` when the pref is absent (e.g. under test mocks).
 */
export function effectiveSubagentMaxDepth(): number {
  const raw = usePreferencesStore.getState()?.subagentMaxDepth;
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(raw)
      : MAX_SUBAGENT_DEPTH;
  return Math.min(5, Math.max(1, n));
}

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  modelId: string;
  toolContext: ToolContext;
  /** Nesting depth of THIS subagent (0 = spawned directly by the main agent). */
  depth?: number;
  onStep?: (label: string) => void;
  /** Label shown in the approval queue: "builder #2". */
  requester?: string;
  abortSignal?: AbortSignal;
};

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  toolContext,
  depth = 0,
  onStep,
  requester,
  abortSignal,
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  // Its own read history. The invariant `edit` enforces - read this file before
  // changing it - is meaningless if it can be satisfied by a read some other
  // agent did, which is what sharing the parent's cache amounted to.
  const ctx: ToolContext = { ...toolContext, readCache: new Map() };

  // Centralized spec: the roster def resolved against the active harness
  // profile, so a sub-agent carries the same profile guidance as the main run
  // (prelude, budget, capabilities) instead of a bare prompt.
  const workspaceRoot = ctx.getWorkspaceRoot();
  const profile = getProfile(activeProfileIdFor(workspaceRoot));
  const spec = buildSubagentSpec(type, profile);

  // The full main-agent toolset plus extension tools - a sub-agent is a peer of
  // the main agent, not a read-only subset. `buildTools` is the same builder the
  // main run uses; extension tools are added the same way the main run adds them
  // (fresh each run, since extensions load and unload while the app is open).
  // `buildAgentTools` then applies the profile's tool rules and withholds the
  // spawn tools at the nesting cap (the one thing governed by depth).
  const available: Record<string, unknown> = {
    ...buildTools(ctx, depth),
    ...buildExtensionTools(),
  };

  const tools: Record<string, unknown> = {};
  const injected = buildAgentTools(available, {
    profile,
    depth,
    maxDepth: effectiveSubagentMaxDepth(),
    subagentType: type,
  });

  // One breaker per run. When the user denies enough times in a row, tripping
  // it aborts the whole generateText call - a tool-level error alone would
  // just hand the model another step to re-ask with.
  const controller = new AbortController();
  const breaker: DenialBreaker = {
    denials: 0,
    tripped: false,
    trip: () => controller.abort(),
  };
  // An outer abort (user stopped the main run) must reach this controller too,
  // or the sub-agent keeps running after the parent is gone.
  if (abortSignal) {
    if (abortSignal.aborted) controller.abort();
    else
      abortSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  for (const [name, found] of Object.entries(injected)) {
    if (!found) continue;
    if (!subagentToolNeedsGate(name, found)) {
      tools[name] = found;
      continue;
    }
    const guarded =
      name === WRITE_FILE ? newFilesOnly(found as AnyTool) : found;
    tools[name] = gate(
      guarded as AnyTool,
      name,
      requester ?? type,
      breaker,
      controller.signal,
    );
  }

  // Multi-model routing: a cheaper or local model can do the fan-out while the
  // frontier model orchestrates. The preference wins when set; otherwise the
  // sub-agent inherits the parent run's model. Resolved through the same
  // builder the main run uses so local and custom-endpoint models work here too.
  //
  // Cost-tier guard (BatikCode parity): a user-set subagent model must not cost
  // more than 1.5x the main model's input price, so a cheap orchestrator is not
  // silently topped up by an expensive worker. Over budget, the sub-agent falls
  // back to the main model instead of overspending.
  const prefs = usePreferencesStore.getState();
  let routedModelId = prefs.subagentModelId.trim() || modelId;
  if (
    prefs.subagentModelId.trim() &&
    subagentModelExceedsBudget(routedModelId, modelId)
  ) {
    void logInfo(
      `[ai] subagent model ${routedModelId} exceeds the main model's cost tier; falling back to ${modelId}`,
    ).catch(() => {});
    routedModelId = modelId;
  }
  const model = await buildConfiguredLanguageModel(routedModelId, keys, {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    ollamaBaseURL: prefs.ollamaBaseURL,
    ollamaModelId: prefs.ollamaModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
    openrouterModelId: prefs.openrouterModelId,
    customEndpoints: prefs.customEndpoints,
    customEndpointKeys: useChatStore.getState().customEndpointKeys,
  });

  // A hung provider (no first token) used to leave a sub-agent on its step
  // forever - the main run aborts after 90s, a sub-agent had no equivalent
  // and could hang a whole run_subagents batch on one stalled model call.
  // Once the first step lands the timer is cleared, so a slow-but-moving
  // sub-agent is not killed. Flagged so the catch can name the cause instead
  // of reporting a bare abort.
  let firstStepTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const armTimer = () => {
    if (firstStepTimer) clearTimeout(firstStepTimer);
    firstStepTimer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("sub-agent model did not respond within 90s"));
    }, 90_000);
  };
  const disarmTimer = () => {
    if (firstStepTimer) {
      clearTimeout(firstStepTimer);
      firstStepTimer = null;
    }
  };

  const runAttempt = (attemptPrompt: string) =>
    generateText({
      model,
      system: spec.systemPrompt,
      prompt: attemptPrompt,
      tools: tools as Parameters<typeof generateText>[0]["tools"],
      // Repair tool-call arguments that a provider (e.g. StepFun) emits as
      // near-JSON, so a recoverable sub-agent tool call runs instead of
      // hard-failing with "Invalid input for tool".
      experimental_repairToolCall: repairToolCall as never,
      // The step cap alone is not enough: a model that repeats the same tool
      // call or stalls without progress burns all twelve steps doing nothing.
      // The same guards the main run uses close that loop here too.
      stopWhen: [
        stepCountIs(spec.maxSteps),
        noToolRepetition(3),
        noProgressStop(2),
        noErrorProgress(3),
      ],
      // Stop has to reach a sub-agent too. Without this, stopping the main run
      // left every spawned agent working - harmless while they only read, not
      // once they write.
      abortSignal: controller.signal,
      experimental_onToolCallStart: disarmTimer,
      onStepFinish: (step) => {
        disarmTimer();
        if (!onStep) return;
        const last = step.toolCalls?.[step.toolCalls.length - 1];
        if (last) onStep(`${type}: ${last.toolName}`);
      },
    });

  const start = Date.now();
  try {
    armTimer();
    let result = await runAttempt(prompt);
    // The empty-completion failure mode: some routed / small compat models
    // answer "no text, no tool call" in a few seconds, and the run used to
    // report that as "(no output)" - indistinguishable from a task that ran
    // and found nothing. Nudge once with an explicit instruction; if the
    // second attempt is empty too, throw so the spawning tool surfaces it as
    // an error result the orchestrator (and noErrorProgress) can act on.
    if (!result.text?.trim() && !subagentMadeProgress(result)) {
      void logInfo(
        `[ai] sub-agent (${type}) returned an empty completion; retrying once`,
      ).catch(() => {});
      armTimer();
      result = await runAttempt(
        `${prompt}\n\n(Your previous attempt returned nothing at all - no text and no tool call. Do the work now: call the tools you need, then finish with a short text answer. Never reply with an empty message.)`,
      );
      if (!result.text?.trim() && !subagentMadeProgress(result)) {
        throw new Error(
          `sub-agent model returned an empty completion twice (no text, no tool calls) - the task did not run; retry it, or switch the sub-agent model in Settings > Agents`,
        );
      }
    }

    // Some models (notably smaller / routed ones) go silent once tool calls
    // fill the history: they burn every step doing tool work and never emit a
    // final assistant text, so `result.text` is empty and the run looked like
    // "(no output)" even though it did the work. Recover by reconstructing what
    // it gathered and asking once more, with NO tools, for a prose summary.
    let summary = result.text?.trim();
    if (!summary) {
      const summaryTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error("sub-agent summary did not respond within 90s"),
        );
      }, SUMMARY_TIMEOUT_MS);
      try {
        summary = await synthesizeSummary(
          model,
          spec.systemPrompt,
          prompt,
          result,
          controller.signal,
        );
      } finally {
        clearTimeout(summaryTimer);
      }
    }
    return {
      summary: summary || "(no output)",
      stepCount: result.steps?.length ?? 0,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    // The denial breaker trips by aborting the run, and a user stop of the
    // main run aborts it from outside. Both surface here as AbortError; turn
    // them into a clean result so the caller sees what happened instead of a
    // raw error string.
    if (controller.signal.aborted) {
      if (firstStepTimer) {
        clearTimeout(firstStepTimer);
        firstStepTimer = null;
      }
      return {
        summary: breaker.tripped
          ? "Stopped: the user denied the same write three times in a row. Nothing was written; report the change as not done."
          : timedOut
            ? "Stopped: the sub-agent model did not respond within 90s."
            : "Stopped: the run was aborted.",
        stepCount: 0,
        durationMs: Date.now() - start,
      };
    }
    if (firstStepTimer) {
      clearTimeout(firstStepTimer);
      firstStepTimer = null;
    }
    throw e;
  }
}
