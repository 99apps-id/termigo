import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type StopCondition,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getModelContextLimit,
  isCompatModelId,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  MLX_DEFAULT_BASE_URL,
  modelKeepsReasoning,
  OLLAMA_DEFAULT_BASE_URL,
  providerNeedsKey,
  resolveModel,
  selectSystemPrompt,
  type CustomEndpoint,
  type ProviderId,
} from "../config";
import { buildTools, type ToolContext } from "../tools/tools";
import type { McpToolset } from "./mcpTools";
import type { ExtensionToolset } from "./extensionTools";
import type { CustomToolset } from "./customToolsIo";
import { skillsBlock, type Skill } from "./skills";
import { compactModelMessagesDetailed } from "./compact";
import { memoryBlock as learnedBlock, type MemoryEntry } from "./memory";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { prepareAgentPrompt } from "./prompt";
import { createProxyFetch, proxyFetch } from "./proxyFetch";
import { sanitizeUiMessages } from "./sanitizeMessages";
import { useDebugStore } from "../store/debugStore";

const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });

const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> =
  {
    read_file: (i) => `Reading ${shortPath(i.path)}`,
    list_directory: (i) => `Listing ${shortPath(i.path)}`,
    grep: (i) => `Grepping ${ellipsize(String(i.pattern ?? ""), 40)}`,
    glob: (i) => `Globbing ${ellipsize(String(i.pattern ?? ""), 40)}`,
    edit: (i) => `Editing ${shortPath(i.path)}`,
    multi_edit: (i) => `Editing ${shortPath(i.path)}`,
    write_file: (i) => `Writing ${shortPath(i.path)}`,
    create_directory: (i) => `Creating ${shortPath(i.path)}`,
    bash_run: (i) => `Running ${ellipsize(String(i.command ?? ""), 60)}`,
    bash_background: (i) =>
      `Spawning ${ellipsize(String(i.command ?? ""), 60)}`,
    bash_logs: () => `Reading logs`,
    bash_list: () => `Listing background processes`,
    bash_kill: () => `Stopping background process`,
    suggest_command: (i) =>
      `Suggesting ${ellipsize(String(i.command ?? ""), 60)}`,
    todo_write: (i) =>
      `Updating plan (${Array.isArray(i.todos) ? i.todos.length : 0} items)`,
    run_subagent: (i) => `Spawning ${String(i.type ?? "subagent")} subagent`,
  };

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export type BuildModelOptions = {
  modelIdOverride?: string;
  lmstudioBaseURL?: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  openaiCompatibleBaseURL?: string;
};

const modelCache = new Map<string, LanguageModel>();

export async function buildLanguageModel(
  provider: ProviderId,
  keys: ProviderKeys,
  resolvedModelId: string,
  options: BuildModelOptions = {},
  customEndpointKey?: string | null,
): Promise<LanguageModel> {
  if (providerNeedsKey(provider) && !keys[provider]) {
    throw new Error(
      `No API key configured for ${provider}. Open Settings → AI to add one.`,
    );
  }
  const key = keys[provider] ?? "";
  const lmstudioURL = options.lmstudioBaseURL ?? LMSTUDIO_DEFAULT_BASE_URL;
  const mlxURL = options.mlxBaseURL ?? MLX_DEFAULT_BASE_URL;
  const ollamaURL = options.ollamaBaseURL ?? OLLAMA_DEFAULT_BASE_URL;
  const compatURL = options.openaiCompatibleBaseURL ?? "";
  const epKey = customEndpointKey ?? "";
  const cacheKey = `${provider} ${key} ${epKey} ${resolvedModelId} ${lmstudioURL} ${mlxURL} ${ollamaURL} ${compatURL}`;
  const hit = modelCache.get(cacheKey);
  if (hit) return hit;

  let built: LanguageModel;
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      built = createOpenAI({ fetch: proxyFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      built = createAnthropic({ fetch: proxyFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      built = createGoogleGenerativeAI({ fetch: proxyFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      built = createXai({ fetch: proxyFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      built = createCerebras({ fetch: proxyFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "deepseek": {
      // Stays on the OpenAI-compatible adapter. The dedicated @ai-sdk/deepseek
      // that pairs with this SDK version is two provider-spec majors behind the
      // rest of the tree; it type-checks by coincidence rather than by being
      // compatible, and DeepSeek works today through the generic path.
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: key,
        fetch: proxyFetch,
      })(resolvedModelId);
      break;
    }
    case "mistral": {
      // The dedicated provider rather than the OpenAI-compatible adapter.
      // Mistral's API is close enough that the generic one connects, but its
      // tool-call wire format differs in ways only this provider handles - the
      // reported symptom was a model that answered in prose instead of
      // emitting a tool call anything downstream could parse.
      const { createMistral } = await import("@ai-sdk/mistral");
      built = createMistral({ apiKey: key, fetch: proxyFetch })(resolvedModelId);
      break;
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      built = createGroq({ fetch: proxyFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "openrouter": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key,
        headers: {
          "HTTP-Referer": "https://termigo.ai",
          "X-Title": "Termigo",
        },
        fetch: proxyFetch,
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      if (!compatURL) {
        throw new Error(
          "OpenAI-compatible provider has no base URL. Set it in Settings → Models.",
        );
      }
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: compatURL,
        apiKey: epKey || key || undefined,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "lmstudio": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "lmstudio",
        baseURL: lmstudioURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "mlx": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "mlx",
        baseURL: mlxURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "ollama": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "ollama",
        baseURL: ollamaURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive as ProviderId}`);
    }
  }
  modelCache.set(cacheKey, built);
  return built;
}

export type LocalProviderConfig = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
  customEndpointKeys?: CustomEndpointKeys;
};

export function buildConfiguredLanguageModel(
  modelId: string,
  keys: ProviderKeys,
  local: LocalProviderConfig = {},
): Promise<LanguageModel> {
  if (isCompatModelId(modelId)) {
    const eid = endpointIdFromCompatModel(modelId);
    const ep = local.customEndpoints?.find((e) => e.id === eid);
    if (!ep) throw new Error(`Custom endpoint not found: ${eid}`);
    if (!ep.modelId.trim()) {
      throw new Error(
        `${ep.name}: no model id set. Open Settings → Models.`,
      );
    }
    return buildLanguageModel(
      "openai-compatible",
      keys,
      ep.modelId.trim(),
      { openaiCompatibleBaseURL: ep.baseURL },
      local.customEndpointKeys?.[eid],
    );
  }
  const m = resolveModel(modelId);
  let resolvedId: string = m.id;
  if (m.id === "lmstudio-local") {
    if (!local.lmstudioModelId?.trim()) {
      throw new Error(
        "LM Studio: no model id set. Open Settings → Models and enter the model id loaded in LM Studio.",
      );
    }
    resolvedId = local.lmstudioModelId.trim();
  } else if (m.id === "mlx-local") {
    if (!local.mlxModelId?.trim()) {
      throw new Error(
        "MLX: no model id set. Open Settings → Models and enter the model id served by mlx_lm.server.",
      );
    }
    resolvedId = local.mlxModelId.trim();
  } else if (m.id === "ollama-local") {
    if (!local.ollamaModelId?.trim()) {
      throw new Error(
        "Ollama: no model id set. Open Settings → Models and enter the model id (e.g. the name from `ollama list`).",
      );
    }
    resolvedId = local.ollamaModelId.trim();
  } else if (m.id === "openai-compatible-custom") {
    if (!local.openaiCompatibleModelId?.trim()) {
      throw new Error(
        "OpenAI-compatible: no model id set. Open Settings → Models.",
      );
    }
    resolvedId = local.openaiCompatibleModelId.trim();
  } else if (m.id === "openrouter-custom") {
    if (!local.openrouterModelId?.trim()) {
      throw new Error(
        "OpenRouter: no model id set. Open Settings → Models and enter an OpenRouter model id (e.g. anthropic/claude-sonnet-5).",
      );
    }
    resolvedId = local.openrouterModelId.trim();
  }
  return buildLanguageModel(m.provider, keys, resolvedId, {
    lmstudioBaseURL: local.lmstudioBaseURL,
    mlxBaseURL: local.mlxBaseURL,
    ollamaBaseURL: local.ollamaBaseURL,
    openaiCompatibleBaseURL: local.openaiCompatibleBaseURL,
  });
}

const PLAN_MODE_PROMPT = `## PLAN MODE — ACTIVE
Mutating tools (write_file, edit, multi_edit, create_directory) will queue their changes for the user to review as a single diff. Do NOT execute bash_run or bash_background while plan mode is active — restrict yourself to reads (read_file, grep, glob, list_directory) and the queued mutations. After queueing the full set of edits, stop and return a brief summary; do not continue acting until the user has accepted/rejected.`;

function buildStableSystem(
  modelId: string,
  persona: { name: string; instructions: string } | null,
  customInstructions: string | undefined,
  projectMemory: string | null,
  learned: readonly MemoryEntry[],
  skills: readonly Skill[],
): string {
  const base = selectSystemPrompt(modelId);
  const personaBlock = persona?.instructions.trim()
    ? `\n\n## ACTIVE AGENT — ${persona.name}\n${persona.instructions.trim()}`
    : "";
  const customBlock = customInstructions?.trim()
    ? `\n\n## USER CUSTOM INSTRUCTIONS — follow unless they conflict with safety rules above\n${customInstructions.trim()}`
    : "";
  const memoryBlock =
    projectMemory && projectMemory.trim().length > 0
      ? `\n\n## PROJECT — TERMIGO.md\n${projectMemory.trim()}`
      : "";
  // Skills sit after facts and before persona: the model should know what it
  // already knows how to do before it is told how to behave.
  return `${base}${memoryBlock}${learnedBlock(learned)}${skillsBlock(skills)}${personaBlock}${customBlock}`;
}

/** Stable key for a value, so equivalent inputs written in a different key
 *  order still compare equal. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** Fingerprint for a tool call. Canonicalizes args so equivalent inputs match. */
function toolCallFingerprint(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input)}`;
}

/**
 * Stops when the last `maxRepeats` steps used the same tool with the same
 * input. Default 3 because some tools (e.g. reading a log) repeat twice
 * legitimately.
 */
export function noToolRepetition<T extends ToolSet>(
  maxRepeats = 3,
): StopCondition<T> {
  return ({ steps }) => {
    if (steps.length < maxRepeats) return false;
    const recent = steps.slice(-maxRepeats);
    const fingerprints: (string | null)[] = recent.map((s) => {
      const calls = s.toolCalls;
      if (!calls || calls.length === 0) return null;
      // Cover the full ordered set of tool calls so parallel multi-tool
      // repetition is caught and a step that only matches on its first call
      // (but differs on the rest) isn't falsely flagged.
      return calls
        .map((c) => toolCallFingerprint(c.toolName, c.input))
        .join("\n");
    });
    if (fingerprints.some((x) => x === null)) return false;
    return fingerprints.every((x) => x === fingerprints[0]);
  };
}

/** Stops after `maxIdle` consecutive text-only steps. A real text turn ends
 *  on its own and never chains another empty step. */
export function noProgressStop<T extends ToolSet>(
  maxIdle = 2,
): StopCondition<T> {
  return ({ steps }) => {
    if (steps.length < maxIdle) return false;
    return steps.slice(-maxIdle).every((s) => (s.toolCalls?.length ?? 0) === 0);
  };
}

/**
 * Why a run ended early, when it did.
 *
 * A single cap could only ever say "out of budget", so a model looping on one
 * tool and a model narrating without acting both looked like ordinary work
 * until the budget ran out. Naming the guard that tripped lets the UI say
 * whether continuing is worth a click.
 */
export type AgentStopReason = "step-cap" | "tool-repetition" | "no-progress";

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type AgentUsageDelta = AgentUsage & {
  lastInputTokens: number;
  lastCachedTokens: number;
};

const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export type RunAgentOptions = {
  keys: ProviderKeys;
  modelId?: string;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: {
    stopReason: AgentStopReason | null;
    finishReason: string;
  }) => void;
  /** Loop budget for this round. Defaults to the first tier; the caller raises
   *  it on each Continue so a long task deepens instead of stalling. */
  stepBudget?: number;
  /** Record the assembled request for the inspector. Read from preferences by
   *  the caller so this module stays free of the settings store. */
  captureDebug?: boolean;
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openaiCompatibleContextLimit?: number;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
  customEndpointKeys?: CustomEndpointKeys;
  planMode?: boolean;
  projectMemory?: string | null;
  /** Facts the agent recorded in earlier sessions (.termigo/memory.md). */
  learnedMemory?: readonly MemoryEntry[];
  /**
   * Tools discovered from configured MCP servers. Passed in rather than built
   * here because discovery has to start each server and await `tools/list`,
   * while `buildTools` is synchronous.
   */
  mcpTools?: McpToolset;
  /** Skill index (names + descriptions). Bodies load on demand. */
  skills?: readonly Skill[];
  /** Tools contributed by enabled extensions. */
  extensionTools?: ExtensionToolset;
  /** Command tools defined in this workspace. */
  customTools?: CustomToolset;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

export async function runAgentStream(opts: RunAgentOptions) {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const model = await buildConfiguredLanguageModel(modelId, opts.keys, {
    lmstudioBaseURL: opts.lmstudioBaseURL,
    lmstudioModelId: opts.lmstudioModelId,
    mlxBaseURL: opts.mlxBaseURL,
    mlxModelId: opts.mlxModelId,
    ollamaBaseURL: opts.ollamaBaseURL,
    ollamaModelId: opts.ollamaModelId,
    openaiCompatibleBaseURL: opts.openaiCompatibleBaseURL,
    openaiCompatibleModelId: opts.openaiCompatibleModelId,
    openrouterModelId: opts.openrouterModelId,
    customEndpoints: opts.customEndpoints,
    customEndpointKeys: opts.customEndpointKeys,
  });
  const endpoints = opts.customEndpoints ?? [];
  const info = resolveModel(modelId, endpoints);
  const provider = info.provider;

  const stableSystem = buildStableSystem(
    modelId,
    opts.agentPersona ?? null,
    opts.customInstructions,
    opts.projectMemory ?? null,
    opts.learnedMemory ?? [],
    opts.skills ?? [],
  );

  const history = await convertToModelMessages(sanitizeUiMessages(opts.uiMessages));
  const keepsReasoning = modelKeepsReasoning(info);
  const prunedHistory = pruneMessages({
    messages: history,
    reasoning: keepsReasoning ? "none" : "before-last-message",
    emptyMessages: "remove",
  });
  const compatCtxOverride = isCompatModelId(modelId)
    ? endpoints.find((e) => e.id === endpointIdFromCompatModel(modelId))
        ?.contextLimit
    : opts.openaiCompatibleContextLimit;
  const compact = compactModelMessagesDetailed(
    prunedHistory,
    getModelContextLimit(modelId, compatCtxOverride),
  );
  const compactedHistory = compact.messages;
  if (compact.compacted) {
    opts.onCompact?.({ droppedCount: compact.droppedCount });
  }

  const prompt = prepareAgentPrompt(
    stableSystem,
    opts.planMode ? PLAN_MODE_PROMPT : null,
    compactedHistory,
    provider,
  );

  let stepsSeen = 0;
  // Three guards, any of which ends the loop. Each wrapper records which one
  // tripped first so the UI can explain the stop instead of offering the same
  // blank "continue" for every cause.
  let stopReason: AgentStopReason | null = null;
  const stepBudget = opts.stepBudget ?? MAX_AGENT_STEPS;
  const capPred = stepCountIs(stepBudget);
  const repeatPred = noToolRepetition<ToolSet>(3);
  const idlePred = noProgressStop<ToolSet>(2);
  const trackingStopWhen: StopCondition<ToolSet>[] = [
    (args) => {
      if (!(capPred(args) as boolean)) return false;
      stopReason ??= "step-cap";
      return true;
    },
    (args) => {
      if (!(repeatPred(args) as boolean)) return false;
      stopReason ??= "tool-repetition";
      return true;
    },
    (args) => {
      if (!(idlePred(args) as boolean)) return false;
      stopReason ??= "no-progress";
      return true;
    },
  ];

  const tools = {
    ...(opts.mcpTools ?? {}),
    ...(opts.extensionTools ?? {}),
    ...(opts.customTools ?? {}),
    ...buildTools(opts.toolContext),
  };

  // Snapshot what is about to be sent, while it is still assembled and before
  // the provider SDK attaches credentials. Off by default; the cost of being
  // on is one object per step, capped at 30 in memory.
  if (opts.captureDebug) {
    useDebugStore.getState().add({
      model: { id: modelId, provider },
      params: {
        stepBudget,
        ...(opts.planMode ? { planMode: true } : {}),
        contextLimit: getModelContextLimit(modelId, compatCtxOverride),
        ...(compact.compacted ? { compactedAway: compact.droppedCount } : {}),
      },
      system: prompt.system,
      messages: prompt.messages,
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        description: (t as { description?: string } | undefined)?.description,
      })),
    });
  }

  return streamText({
    model,
    system: prompt.system,
    messages: prompt.messages,
    allowSystemInMessages: false,
    // MCP last: a server cannot shadow a built-in tool by naming a tool after
    // it, and the `mcp__` prefix means a collision would take deliberate effort
    // anyway.
    // Built-ins last: neither an extension nor an MCP server can shadow a
    // core tool by naming one after it, and the prefixes make a collision take
    // deliberate effort anyway.
    tools,
    // The SDK infers a specific ToolSet from `tools` and refuses our generic
    // `StopCondition<ToolSet>[]`. The predicates only touch fields common to
    // every ToolSet, so a structural cast is safe.
    stopWhen: trackingStopWhen as never,
    abortSignal: opts.abortSignal,
    onStepFinish: (step) => {
      stepsSeen++;
      if (opts.onStep) {
        const last = step.toolCalls?.[step.toolCalls.length - 1];
        if (last) {
          const label = TOOL_LABELS[last.toolName];
          opts.onStep(
            label
              ? label((last.input ?? {}) as Record<string, unknown>)
              : `Calling ${last.toolName}`,
          );
        } else if (step.text) {
          opts.onStep("Writing");
        }
      }
      if (opts.onUsage && step.usage) {
        const u = step.usage;
        const stepInput = u.inputTokens ?? 0;
        const stepCached = u.inputTokenDetails?.cacheReadTokens ?? 0;
        opts.onUsage({
          inputTokens: stepInput,
          outputTokens: u.outputTokens ?? 0,
          cachedInputTokens: stepCached,
          lastInputTokens: stepInput,
          lastCachedTokens: stepCached,
        });
      }
    },
    onFinish: (result) => {
      opts.onStep?.(null);
      const finishReason =
        (result as { finishReason?: string } | undefined)?.finishReason ?? "";
      // The predicates fire before the final step is counted in some SDK
      // paths, so fall back to the step count rather than reporting no reason
      // for a run that plainly ran out of budget.
      opts.onFinishMeta?.({
        stopReason:
          stopReason ?? (stepsSeen >= stepBudget ? "step-cap" : null),
        finishReason,
      });
    },
  });
}

export { EMPTY_USAGE };
