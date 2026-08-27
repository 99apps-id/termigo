import { generateText, stepCountIs } from "ai";
import { buildConfiguredLanguageModel, noProgressStop, noToolRepetition } from "../lib/agent";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { buildTools } from "../tools/tools";
import { buildExtensionTools } from "../lib/extensionTools";
import { isExtensionTool } from "../lib/extensionToolNames";
import { isMcpTool } from "../lib/mcpToolNames";
import { isCustomTool } from "../lib/customToolNames";
import { isAutoApprovedScan } from "../lib/pentestScope";
import { summarizeInput } from "../lib/approvalQueue";
import { subagentWriteNeedsApproval } from "../lib/approvalPolicy";
import {
  isSessionAllowed,
  rememberSessionAllowed,
  useApprovalQueue,
} from "../store/approvalQueueStore";
import { useChatStore } from "../store/chatStore";
import { usePlanStore } from "../store/planStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentAlwaysAllowedTools } from "@/modules/settings/store";
import { native } from "../lib/native";
import { SUBAGENTS, type SubagentType } from "./registry";

const SUBAGENT_MAX_STEPS = 12;

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  modelId: string;
  toolContext: ToolContext;
  onStep?: (label: string) => void;
  /** Label shown in the approval queue: "builder #2". */
  requester?: string;
  abortSignal?: AbortSignal;
};

/**
 * `write_file` is the one write with no read-before check, so a sub-agent gets
 * the same new-files-only guard the builder had - see `newFilesOnly`.
 */
const WRITE_FILE = "write_file";

/**
 * Tools a sub-agent never receives.
 *
 * Recursion: a sub-agent that could call `run_subagent` / `run_subagents` would
 * spawn its own sub-agents and nest without bound. It is the single capability
 * that keeps a sub-agent from being a full peer of the main agent, on purpose.
 */
const WITHHELD = new Set(["run_subagent", "run_subagents"]);

/**
 * Whether a sub-agent tool must route through the approval queue rather than
 * auto-run.
 *
 * A sub-agent holds the same toolset as the main agent, so this is the security
 * floor that makes that safe: everything the main agent would stop and ask for
 * asks here too. A built-in tool that mutates or runs a command declares
 * `needsApproval`; third-party tools (extension / MCP / custom) are always
 * policy-governed by name. Read-only file/search tools carry neither signal and
 * auto-run, exactly as they do for the main agent.
 */
export function subagentToolNeedsGate(name: string, tool?: unknown): boolean {
  if (isExtensionTool(name) || isMcpTool(name) || isCustomTool(name)) return true;
  return (tool as { needsApproval?: unknown } | undefined)?.needsApproval === true;
}

/**
 * How many consecutive denials end the run outright.
 *
 * A denied write returns an error result, and a model that ignores the "do
 * not retry" instruction simply asks again - that was the loop this breaker
 * closes. Three denials in a row is a conversation the user is losing; the
 * sub-agent stops itself instead of spending its whole step budget re-asking.
 */
const MAX_CONSECUTIVE_DENIALS = 3;

type AnyTool = { execute?: (input: never, opts: never) => unknown };

/** Shared loop-breaker state for one sub-agent run. */
type DenialBreaker = {
  denials: number;
  tripped: boolean;
  /** Ends the run: no further model step can re-ask. */
  trip: () => void;
};

/**
 * Make a tool ask before it acts.
 *
 * The SDK's own `needsApproval` cannot be used here: it works by ending the
 * run and resuming from the next request, and a sub-agent has no message
 * boundary to end at. `execute` is plain async code in the same runtime as the
 * UI, so it can just wait for the user - which is what the approval queue is.
 *
 * The answer is a decision, not a yes/no: besides approve-once and deny, the
 * user can allow the tool for this session or permanently, both of which are
 * remembered here so later calls of the same tool skip the queue entirely.
 */
function gate<T extends AnyTool>(
  tool: T,
  toolName: string,
  requester: string,
  breaker: DenialBreaker,
  abortSignal?: AbortSignal,
): T {
  const inner = tool.execute;
  if (!inner) return tool;
  return {
    ...tool,
    execute: async (input: never, opts: never) => {
      // A session or permanent allowance answers the question before it is
      // asked. Checked first so an allowed tool never touches the queue,
      // whatever the approval mode says.
      if (isSessionAllowed(toolName)) return inner(input, opts);
      if (
        usePreferencesStore
          .getState()
          .agentAlwaysAllowedTools.includes(toolName)
      ) {
        return inner(input, opts);
      }

      // Scoped auto-approval: an in-scope, read-tier scan (nmap -sV, ffuf, ...)
      // against a target already in the authorized scope runs without a prompt
      // when the user turned that on. Exploit-grade tools and out-of-scope
      // targets still ask. This is what makes an unattended guardian run
      // feasible without hundreds of clicks; the shell fence has already
      // refused anything outside scope before the command reaches here.
      if (toolName === "bash_run" || toolName === "bash_background") {
        const cmd = (input as { command?: unknown }).command;
        const prefs = usePreferencesStore.getState();
        if (
          typeof cmd === "string" &&
          isAutoApprovedScan(cmd, prefs.pentestScope, prefs.autoApproveInScopeScans)
        ) {
          return inner(input, opts);
        }
      }

      const mustAsk = subagentWriteNeedsApproval(
        toolName,
        usePreferencesStore.getState().agentApprovalMode,
        {
          planActive: usePlanStore.getState().active,
          onRemoteHost: !!useChatStore.getState().live.getRemoteSession(),
        },
      );
      if (!mustAsk) return inner(input, opts);

      const decision = await useApprovalQueue.getState().request(
        { requester, toolName, summary: summarizeInput(input) },
        abortSignal,
      );

      if (decision === "allow-session") {
        rememberSessionAllowed(toolName);
        breaker.denials = 0;
        return inner(input, opts);
      }
      if (decision === "allow-always") {
        rememberSessionAllowed(toolName);
        const list = usePreferencesStore.getState().agentAlwaysAllowedTools;
        if (!list.includes(toolName)) {
          // Fire-and-forget: the call is approved the moment the user clicks,
          // and a slow disk write must not delay it.
          void setAgentAlwaysAllowedTools([...list, toolName]);
        }
        breaker.denials = 0;
        return inner(input, opts);
      }
      if (decision === "approve") {
        breaker.denials = 0;
        return inner(input, opts);
      }

      // Denied. Count consecutive denials and stop the run when the user is
      // clearly saying no - otherwise the model can spend every remaining
      // step re-asking the same question.
      breaker.denials++;
      if (breaker.denials >= MAX_CONSECUTIVE_DENIALS) {
        breaker.tripped = true;
        breaker.trip();
        return {
          error:
            "denied by the user three times in a row. This sub-agent is stopping; report the write as not done.",
        };
      }
      return {
        error:
          "denied by the user. Do not retry this write; report it as not done.",
      };
    },
  };
}

/**
 * Refuse `write_file` on a path that already exists.
 *
 * `edit` fails loudly when a sibling changed the file first, because it has to
 * match `old_string`. `write_file` has no such check - it replaces the whole
 * file - so with several builders running it is the one call that can silently
 * destroy another's work. Creating new files stays allowed, which is what a
 * builder actually needs.
 */
function newFilesOnly<T extends AnyTool>(tool: T): T {
  const inner = tool.execute;
  if (!inner) return tool;
  return {
    ...tool,
    execute: async (input: never, opts: never) => {
      const path = (input as { path?: unknown })?.path;
      if (typeof path === "string") {
        const existing = await native.readFile(path).catch(() => null);
        if (existing) {
          return {
            error: `${path} already exists. A builder may only create new files - use edit for an existing one.`,
          };
        }
      }
      return inner(input, opts);
    },
  };
}

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

  // The full main-agent toolset plus extension tools - a sub-agent is a peer of
  // the main agent, not a read-only subset. `buildTools` is the same builder the
  // main run uses; extension tools are added the same way the main run adds them
  // (fresh each run, since extensions load and unload while the app is open).
  const available: Record<string, unknown> = {
    ...buildTools(ctx),
    ...buildExtensionTools(),
  };

  const tools: Record<string, unknown> = {};

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
    else abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  for (const [name, found] of Object.entries(available)) {
    if (!found || WITHHELD.has(name)) continue;
    if (!subagentToolNeedsGate(name, found)) {
      tools[name] = found;
      continue;
    }
    const guarded = name === WRITE_FILE ? newFilesOnly(found as AnyTool) : found;
    tools[name] = gate(guarded as AnyTool, name, requester ?? type, breaker, controller.signal);
  }

  // Multi-model routing: a cheaper or local model can do the fan-out while the
  // frontier model orchestrates. The preference wins when set; otherwise the
  // sub-agent inherits the parent run's model. Resolved through the same
  // builder the main run uses so local and custom-endpoint models work here too.
  const prefs = usePreferencesStore.getState();
  const routedModelId = prefs.subagentModelId.trim() || modelId;
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
  firstStepTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("sub-agent model did not respond within 90s"));
  }, 90_000);

  const start = Date.now();
  try {
    const result = await generateText({
      model,
      system: def.systemPrompt,
      prompt,
      tools: tools as Parameters<typeof generateText>[0]["tools"],
      // The step cap alone is not enough: a model that repeats the same tool
      // call or stalls without progress burns all twelve steps doing nothing.
      // The same guards the main run uses close that loop here too.
      stopWhen: [
        stepCountIs(SUBAGENT_MAX_STEPS),
        noToolRepetition(3),
        noProgressStop(2),
      ],
      // Stop has to reach a sub-agent too. Without this, stopping the main run
      // left every spawned agent working - harmless while they only read, not
      // once they write.
      abortSignal: controller.signal,
      experimental_onToolCallStart: () => {
        if (firstStepTimer) {
          clearTimeout(firstStepTimer);
          firstStepTimer = null;
        }
      },
      onStepFinish: (step) => {
        if (firstStepTimer) {
          clearTimeout(firstStepTimer);
          firstStepTimer = null;
        }
        if (!onStep) return;
        const last = step.toolCalls?.[step.toolCalls.length - 1];
        if (last) onStep(`${type}: ${last.toolName}`);
      },
    });

    return {
      summary: result.text || "(no output)",
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
