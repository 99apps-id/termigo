import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type StopCondition,
  type ToolSet,
  type ModelMessage,
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
  modelAllowsForcedToolChoice,
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
import { wantsForcedFanout } from "./orchestrationIntent";
import { useDebugStore } from "../store/debugStore";
import { info as logInfo } from "@tauri-apps/plugin-log";

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
    // Named rather than left to the "Calling remember" fallback: what is being
    // written outlives the run, so it is the one tool whose argument matters
    // more than its name.
    remember: (i) => `Remembering: ${ellipsize(String(i.fact ?? ""), 60)}`,
  };

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The newest thing the user actually typed.
 *
 * Not simply the last user message: the environment block travels as a user
 * turn of its own now, so the last one is `<env>…</env>` rather than a
 * request. Walking back past any turn that is only an env block finds the
 * message a decision should be made about.
 */
export function latestUserRequest(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content as { type: string; text?: string }[])
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
    if (text.replace(/<env>[\s\S]*?<\/env>/gi, " ").trim()) return text;
  }
  return "";
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

/**
 * The per-run performance summary, surfaced on screen so "why is it slow" has
 * an answer without reading the app log. Mirrors the run-log line but as
 * structured data the UI can render.
 */
export type RunDiagnostics = {
  contextMs: number;
  promptBytes: {
    system: number;
    project: number;
    learned: number;
    tools: number;
    total: number;
  };
  toolCount: number;
  tokens: { input: number; output: number; cached: number };
  cachePct: number;
  steps: number;
  stepBudget: number;
  stopReason: AgentStopReason | null;
  finishReason: string;
  modelId: string;
  provider: string;
  contextLimit: number;
  compactedAway: number | null;
  at: number;
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
  /** A durable fact was written to project memory. Surfaced because it
   *  outlives the run and, in the permissive modes, needed no click. */
  onRemember?: (info: { fact: string }) => void;
  onFinishMeta?: (info: {
    stopReason: AgentStopReason | null;
    finishReason: string;
    /** Per-run performance summary for the on-screen diagnostics view. */
    metrics: RunDiagnostics;
  }) => void;
  /** Loop budget for this round. Defaults to the first tier; the caller raises
   *  it on each Continue so a long task deepens instead of stalling. */
  stepBudget?: number;
  /** Record the assembled request for the inspector. Read from preferences by
   *  the caller so this module stays free of the settings store. */
  captureDebug?: boolean;
  /** How long the caller spent assembling context before this ran. Reported in
   *  the per-run line so the wait before the model is visible next to the wait
   *  caused by the model. */
  contextMs?: number;
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

  // What the model is handed before it reads a word of the request. Measured
  // as components rather than one number: a total says "slow", a breakdown
  // says which addition made it slow. `system` here is the base prompt plus
  // skills, persona and custom instructions - project and learned memory are
  // reported separately even though they live inside it, so the two that grow
  // on their own are visible on their own.
  const projectBytes = opts.projectMemory?.length ?? 0;
  const learnedBytes = learnedBlock(opts.learnedMemory ?? []).length;
  const systemTotal = prompt.system.reduce(
    (n, m) => n + String(m.content).length,
    0,
  );
  // Counting name and description alone reported 11.6 KB where the real
  // payload was nearer 33 KB, because the input schemas are the bulk of it -
  // and an undercount in the one report meant to catch growth is worse than
  // no number at all.
  //
  // MCP tools are built with `jsonSchema()`, which keeps the raw schema on
  // `.jsonSchema`, so the third-party half - the part that arrives unbounded
  // from someone else's server - is measured exactly. Built-in tools describe
  // themselves with Zod, which only becomes JSON at request time; they are
  // approximated by their description. That side is fixed and changes only
  // when this repo changes it, which is the half that needs watching least.
  const toolBytes = JSON.stringify(
    Object.entries(tools).map(([name, t]) => {
      const tool = t as
        | { description?: string; inputSchema?: { jsonSchema?: unknown } }
        | undefined;
      return {
        name,
        description: tool?.description,
        schema: tool?.inputSchema?.jsonSchema,
      };
    }),
  ).length;
  const toolCount = Object.keys(tools).length;

  // Pin the first step to a fan-out when the request is broad enough to be
  // worth dividing. A prompt-level mandate does not hold: models read files
  // inline regardless of what the system prompt asks for, which is how the
  // feature ends up present and unused.
  //
  // `latestUserRequest` skips the trailing env turn on purpose. Since the
  // environment moved into a message of its own, the last user message is that
  // block rather than anything the user typed - reading it would test the
  // workspace path for breadth words instead of the request.
  // Pinning is an optimisation, not a requirement: without it the model still
  // has `run_subagents` and the prompt still describes when to use it. So a
  // model that rejects a pinned choice loses some reliability of delegation,
  // which is far better than losing the request.
  const forceFanout =
    "run_subagents" in tools &&
    modelAllowsForcedToolChoice(info) &&
    wantsForcedFanout(latestUserRequest(prompt.messages));
  const promptBytes = {
    system: Math.max(0, systemTotal - projectBytes - learnedBytes),
    project: projectBytes,
    learned: learnedBytes,
    tools: toolBytes,
    total: systemTotal + toolBytes,
  };

  let runInput = 0;
  let runCached = 0;
  let runOutput = 0;

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
    // Only step 0, and only the choice - the model still decides the tasks,
    // and every step after this one is free again so it can synthesise.
    ...(forceFanout
      ? {
          prepareStep: ({ stepNumber }: { stepNumber: number }) =>
            stepNumber === 0
              ? { toolChoice: { type: "tool", toolName: "run_subagents" } }
              : {},
        }
      : {}),
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
      // A memory write outlives the conversation it was made in, and in the
      // permissive approval modes it happens without a click. Four wrong facts
      // once rode in unnoticed and steered every later reply until the file
      // was read by hand. Announcing it is what makes that catchable.
      for (const r of step.toolResults ?? []) {
        const result = r as {
          toolName?: string;
          output?: { stored?: boolean; remembered?: string };
        };
        if (result.toolName !== "remember") continue;
        // Only when it actually stored: the tool declines duplicates and
        // over-long facts, and announcing those would be a lie.
        if (result.output?.stored && result.output.remembered) {
          opts.onRemember?.({ fact: result.output.remembered });
        }
      }
      if (step.usage) {
        runInput += step.usage.inputTokens ?? 0;
        runCached += step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
        runOutput += step.usage.outputTokens ?? 0;
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
      const settledStop =
        stopReason ?? (stepsSeen >= stepBudget ? "step-cap" : null);
      const kb = (n: number) => (n / 1024).toFixed(1);
      const cachePct =
        runInput > 0 ? Math.round((runCached / runInput) * 100) : 0;
      const metrics: RunDiagnostics = {
        contextMs: Math.round(opts.contextMs ?? 0),
        promptBytes,
        toolCount,
        tokens: {
          input: runInput,
          output: runOutput,
          cached: runCached,
        },
        cachePct,
        steps: stepsSeen,
        stepBudget,
        stopReason: settledStop,
        finishReason,
        modelId,
        provider,
        contextLimit: getModelContextLimit(modelId, compatCtxOverride),
        compactedAway: compact.compacted ? compact.droppedCount : null,
        at: Date.now(),
      };
      opts.onFinishMeta?.({ stopReason: settledStop, finishReason, metrics });

      // One line per run, in the app log rather than only on screen.
      //
      // Every performance question this project has had was answered by
      // archaeology: reading the session store off disk, writing throwaway
      // scripts, sampling TCP connections. The prompt reached 38 KB across
      // sixty-odd commits with nothing reporting that it had, and "slower than
      // it used to be" could not be checked against anything.
      //
      // The composition is the part that prevents a repeat. A feature that
      // adds ten kilobytes to every request shows up here the day it lands,
      // instead of six months later as a feeling.
      void logInfo(
        `run: context ${Math.round(opts.contextMs ?? 0)}ms | ` +
          `prompt ${kb(promptBytes.total)}KB ` +
          `(sys ${kb(promptBytes.system)} / proj ${kb(promptBytes.project)} / ` +
          // Count as well as size: 11.6 KB alone cannot tell "no MCP server
          // attached" from "one attached that measures small", and the first
          // reading of this line asked exactly that question.
          `mem ${kb(promptBytes.learned)} / ${toolCount} tools ${kb(promptBytes.tools)}) | ` +
          `tokens ${runInput}in ${runOutput}out, cache ${cachePct}% | ` +
          `steps ${stepsSeen}/${stepBudget} | stop ${settledStop ?? (finishReason || "done")} | ` +
          `${modelId}`,
      ).catch(() => {});
    },
  });
}

export { EMPTY_USAGE };
