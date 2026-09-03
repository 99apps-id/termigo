import { info as logInfo } from "@tauri-apps/plugin-log";
import {
  convertToModelMessages,
  type LanguageModel,
  type ModelMessage,
  pruneMessages,
  type StopCondition,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";
import { buildAgentTools } from "../agents/agentFactory";
import {
  CHATGPT_BASE_URL,
  CHATGPT_HEADERS,
  type CustomEndpoint,
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  estimateCost,
  getModelContextLimit,
  isCompatModelId,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  MLX_DEFAULT_BASE_URL,
  modelAllowsForcedToolChoice,
  modelKeepsReasoning,
  OLLAMA_DEFAULT_BASE_URL,
  type ProviderId,
  providerNeedsKey,
  resolveModel,
  selectSystemPrompt,
} from "../config";
import { useDebugStore } from "../store/debugStore";
import { useTodosStore } from "../store/todoStore";
import { useTrajectoryStore } from "../store/trajectoryStore";
import { formatInvariantsBlock } from "../tools/invariant";
import { buildTools, type ToolContext } from "../tools/tools";
import { getChatGptAccess } from "./chatgptAuth";
import { compactModelMessagesDetailed, estimateTokens } from "./compact";
import { evictObsoleteToolOutputs } from "./contextEviction";
import { effectiveContextLimit } from "./contextLimitLearning";
import { pruneVerifiedPrefix } from "./contextPrune";
import type { CustomToolset } from "./customToolsIo";
import type { ExtensionToolset } from "./extensionTools";
import { recordRun } from "./harnessFrontier";
import {
  appendSystemHint,
  applyProfileToStepBudget,
  applyProfileToSystem,
  getProfile,
} from "./harnessProfile";
import { activeProfileIdFor } from "./harnessProfileStore";
import { fireHooksForEvent, makeRunId } from "./hooksRunner";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import type { McpToolset } from "./mcpTools";
import { memoryBlock as learnedBlock, type MemoryEntry } from "./memory";
import { wantsForcedFanout } from "./orchestrationIntent";
import { prepareAgentPrompt } from "./prompt";
import { createProxyFetch } from "./proxyFetch";
import { repairToolCall } from "./repairToolCall";
import { sanitizeUiMessages } from "./sanitizeMessages";
import { type Skill, skillsBlock } from "./skills";
import { formatTodoStatusBlock } from "./todos";
import { modelRejectsForcedToolChoice } from "./toolChoiceLearning";

// Every model/provider connection uses a trusted, user-configured endpoint, so
// it must honour the machine's own DNS — including a provider host that a proxy,
// VPN, or regional route resolves to a private address (which is exactly what
// blocked deepseek/openai for users on such networks). SSRF hardening belongs on
// AGENT-controlled URLs (the `fetch` tool, the browser), not on the model API
// the user configured. So all providers, cloud and local, share this fetch.
const apiFetch = createProxyFetch({ allowPrivateNetwork: true });

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
      built = createOpenAI({ fetch: apiFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      built = createAnthropic({ fetch: apiFetch, apiKey: key })(
        resolvedModelId,
      );
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      built = createGoogleGenerativeAI({ fetch: apiFetch, apiKey: key })(
        resolvedModelId,
      );
      break;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      built = createXai({ fetch: apiFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      built = createCerebras({ fetch: apiFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "deepseek": {
      // Stays on the OpenAI-compatible adapter. The dedicated @ai-sdk/deepseek
      // that pairs with this SDK version is two provider-spec majors behind the
      // rest of the tree; it type-checks by coincidence rather than by being
      // compatible, and DeepSeek works today through the generic path.
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: key,
        fetch: apiFetch,
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
      built = createMistral({ apiKey: key, fetch: apiFetch })(resolvedModelId);
      break;
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      built = createGroq({ fetch: apiFetch, apiKey: key })(resolvedModelId);
      break;
    }
    case "openrouter": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key,
        headers: {
          "HTTP-Referer": "https://termigo.ai",
          "X-Title": "Termigo",
        },
        fetch: apiFetch,
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      if (!compatURL) {
        throw new Error(
          "OpenAI-compatible provider has no base URL. Set it in Settings → Models.",
        );
      }
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: compatURL,
        apiKey: epKey || key || undefined,
        fetch: apiFetch,
      })(resolvedModelId);
      break;
    }
    case "lmstudio": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "lmstudio",
        baseURL: lmstudioURL,
        fetch: apiFetch,
      })(resolvedModelId);
      break;
    }
    case "mlx": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "mlx",
        baseURL: mlxURL,
        fetch: apiFetch,
      })(resolvedModelId);
      break;
    }
    case "ollama": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "ollama",
        baseURL: ollamaURL,
        fetch: apiFetch,
      })(resolvedModelId);
      break;
    }
    case "chatgpt": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const auth = await getChatGptAccess();
      if (!auth) {
        throw new Error(
          "Not signed in with a ChatGPT account. Open Settings → Models and sign in, or pick an API-key model.",
        );
      }
      // `.responses()`: this backend speaks the Responses API only. `apiFetch`
      // proxies through Rust, which is REQUIRED here — chatgpt.com sends no CORS
      // headers for this route and the webview refuses to send `originator`.
      // Returned, NOT cached: the access token rotates on refresh, so a cached
      // model would keep serving an expired token until restart.
      return createOpenAI({
        baseURL: CHATGPT_BASE_URL,
        apiKey: auth.accessToken,
        headers: {
          ...CHATGPT_HEADERS,
          // Omitted rather than sent empty when the claim was missing: an empty
          // header reads as "account none" and 401s less clearly than absence.
          ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
        },
        fetch: apiFetch,
      }).responses(resolvedModelId);
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
      throw new Error(`${ep.name}: no model id set. Open Settings → Models.`);
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
  // The chatgpt-* ids are internal (they avoid colliding with the same-named
  // key-billed OpenAI models); the Codex backend expects the bare model name.
  if (m.id === "chatgpt-codex") resolvedId = "gpt-5.3-codex";
  else if (m.id === "chatgpt-codex-mini") resolvedId = "gpt-5.3-codex-mini";
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
  // Pinned invariants are constraints the agent itself flagged as session-wide,
  // so they sit with the other durable facts and ride along on every step.
  const invariantBlock = formatInvariantsBlock();
  const invariantSection = invariantBlock ? `\n\n${invariantBlock}` : "";
  // Skills sit after facts and before persona: the model should know what it
  // already knows how to do before it is told how to behave.
  return `${base}${memoryBlock}${learnedBlock(learned)}${invariantSection}${skillsBlock(skills)}${personaBlock}${customBlock}`;
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
 * Cheap digest of a tool result for the repetition fingerprint.
 *
 * The repetition guard compares calls by tool + input, which is right for a
 * true loop but wrong for the common read -> edit -> read (verify) cycle:
 * the same `read_file` call with the same path recurs, yet each read returns
 * different content because the edit changed the file. Folding a digest of
 * the output into the fingerprint treats "same call, changed result" as
 * progress, and keeps "same call, same result" as repetition.
 *
 * FNV-1a over the first 4 KB plus the length: enough to tell changed output
 * apart without hashing megabyte-sized results on every step.
 */
function resultDigest(output: unknown): string {
  if (output === undefined || output === null) return "";
  let text: string;
  try {
    text = typeof output === "string" ? output : JSON.stringify(output);
  } catch {
    text = String(output);
  }
  const bounded = text.length > 4096 ? text.slice(0, 4096) : text;
  let h = 2166136261;
  for (let i = 0; i < bounded.length; i++) {
    h ^= bounded.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/**
 * Stops when the same tool call (same tool + same input) recurs
 * `maxRepeats` times inside a sliding window.
 *
 * A straight tail check (last N steps identical) lets a loop that alternates
 * between two calls - read A, read B, read A, read B - slip past forever,
 * because no two consecutive steps match. Counting recurrences across the
 * window catches both the consecutive loop and the alternating one.
 * Default 3 because some tools (e.g. reading a log) repeat twice
 * legitimately; window is `maxRepeats * 2 - 1` so a 2-cycle shows up.
 */
export function noToolRepetition<T extends ToolSet>(
  maxRepeats = 3,
): StopCondition<T> {
  return ({ steps }) => {
    if (steps.length < maxRepeats) return false;
    const window = Math.max(maxRepeats * 2 - 1, maxRepeats);
    const recent = steps.slice(-window);
    const counts = new Map<string, number>();
    for (const s of recent) {
      const calls = s.toolCalls;
      if (!calls || calls.length === 0) continue;
      // Cover the full ordered set of tool calls so parallel multi-tool
      // repetition is caught and a step that only matches on its first call
      // (but differs on the rest) isn't falsely flagged.
      const results = new Map(
        (s.toolResults ?? []).map((r) => [
          (r as { toolCallId?: string }).toolCallId,
          (r as { output?: unknown }).output,
        ]),
      );
      const fp = calls
        .map(
          (c) =>
            toolCallFingerprint(c.toolName, c.input) +
            "::" +
            resultDigest(results.get(c.toolCallId)),
        )
        .join("\n");
      const n = (counts.get(fp) ?? 0) + 1;
      if (n >= maxRepeats) return true;
      counts.set(fp, n);
    }
    return false;
  };
}

/**
 * Decides, when a guard would stop a stuck run, whether to stop now or hold for
 * one final tool-less "synthesis" step so the model can summarise instead of
 * ending on a silent repeated tool call.
 *
 * - Model can't take a forced tool choice → stop immediately (no synthesis).
 * - First trip on a synthesis-capable model → don't stop; mark it requested.
 * - The synthesis step already ran (requested) → stop now.
 */
export function synthesisStopDecision(
  allowSynthesis: boolean,
  alreadyRequested: boolean,
): { stop: boolean; requested: boolean } {
  if (!allowSynthesis) return { stop: true, requested: false };
  if (alreadyRequested) return { stop: true, requested: true };
  return { stop: false, requested: true };
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

/** True when a tool result is an error (or failure) rather than data. */
function isErrorResult(output: unknown): boolean {
  if (output == null || typeof output !== "object") return false;
  const record = output as Record<string, unknown>;
  // A tool surfaced its failure as an { error: "..." } object.
  if (record.error) return true;
  // Command tools (bash_run, git_*, run_checks, test_loop) report failure as a
  // non-zero exit_code or a timed_out flag, not an { error } object. Missing
  // them here meant a command that kept failing was invisible to noErrorProgress
  // and the agent retried it round after round — the "hang" seen when lint or
  // build never passes.
  const code = record.exit_code;
  if (typeof code === "number" && code !== 0) return true;
  if (record.timed_out === true) return true;
  return false;
}

/**
 * Stops after `maxErrors` consecutive steps in which EVERY tool call returned an
 * error, so a run stuck on a persistently failing tool (command not found, path
 * denied, a server that keeps rejecting) does not burn round after round
 * retrying it.
 *
 * A step that produced any real result is progress, even if one call in a batch
 * failed; only a step where the agent got nothing back counts. This catches the
 * agent trying a slightly different input each time, which `noToolRepetition`
 * (which matches by input) would miss.
 */
export function noErrorProgress<T extends ToolSet>(
  maxErrors = 3,
): StopCondition<T> {
  return ({ steps }) => {
    if (steps.length < maxErrors) return false;
    return steps
      .slice(-maxErrors)
      .every((s: { toolCalls?: unknown[]; toolResults?: unknown[] }) => {
        const calls = s.toolCalls;
        if (!calls || calls.length === 0) return false;
        const results = new Map(
          (s.toolResults ?? []).map((r) => [
            (r as { toolCallId?: string }).toolCallId,
            (r as { output?: unknown }).output,
          ]),
        );
        return calls.every((c) =>
          isErrorResult(results.get((c as { toolCallId?: string }).toolCallId)),
        );
      });
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
export type AgentStopReason =
  | "step-cap"
  | "tool-repetition"
  | "no-progress"
  | "tool-error"
  | "cost-cap"
  | "steered"
  | "aborted"
  | "interrupted";

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
  estimatedCostUsd: number | null;
  costBudgetUsd: number;
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
  /** An early, verified span of the transcript was replaced by a checkpoint
   *  summary (context pruning) before this request was sent. */
  onPrune?: (info: { prunedMessages: number }) => void;
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
  /** Maximum cost in USD allowed for this run. 0 = unlimited. */
  costBudgetUsd?: number;
  /** Record the assembled request for the inspector. Read from preferences by
   *  the caller so this module stays free of the settings store. */
  captureDebug?: boolean;
  /** Parsed hooks config for this workspace. */
  hooksConfig?: import("../lib/hooks").HooksConfig;
  /** Stable run id for hook payload files. */
  runId?: string;
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
  /** Returns true when the user has queued a message while this run is in
   *  flight. The run then stops at the next step boundary so the queued task is
   *  handled promptly instead of waiting for a long run to finish. */
  hasPendingSteer?: () => boolean;
};

export async function runAgentStream(opts: RunAgentOptions) {
  logInfo(
    `[ai] runAgentStream: enter (model=${opts.modelId ?? DEFAULT_MODEL_ID})`,
  );
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

  const history = await convertToModelMessages(
    sanitizeUiMessages(opts.uiMessages),
  );
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
  // The transcript is not the whole request. Reserve room for the system
  // prompt (measured), the tool schemas, and the model's own answer, so
  // compaction targets what is actually left for history instead of the raw
  // window — this is what stopped a compacted-but-still-huge request from
  // arriving just over the model's hard limit.
  const systemChars =
    stableSystem.length + (opts.planMode ? PLAN_MODE_PROMPT.length : 0);
  // Tool schemas (the full toolset serialised) plus completion headroom and a
  // safety margin. Generous on purpose: over-reserving only compacts a little
  // earlier, while under-reserving is what overflows the window. 32k (not 24k)
  // because a large toolset's schemas (e.g. 100+ tools ≈ 10k tokens) also count
  // against the same window and were previously left unreserved.
  const TOOLS_AND_OUTPUT_RESERVE_TOKENS = 32_000;
  const reservedTokens =
    estimateTokens(systemChars) + TOOLS_AND_OUTPUT_RESERVE_TOKENS;
  // The limit compaction targets is the configured window, but capped by what
  // the provider actually accepted before (learned from a prior overflow) and
  // scaled down when a previous request overshot — so a wrong config or an
  // undercounting estimate self-corrects on the retry instead of failing again.
  const configuredLimit = getModelContextLimit(modelId, compatCtxOverride);
  const compactionLimit = effectiveContextLimit(modelId, configuredLimit);
  const compact = compactModelMessagesDetailed(
    prunedHistory,
    compactionLimit,
    reservedTokens,
  );
  const compactedHistory = compact.messages;
  if (compact.compacted) {
    opts.onCompact?.({ droppedCount: compact.droppedCount });
  }

  // Compaction trims by size; this trims by redundancy. A file read three
  // times across a long turn keeps three copies in history, of which only the
  // newest can still matter. Collapse the stale ones before the prompt is
  // assembled so the savings land on the request that is about to be sent.
  const eviction = evictObsoleteToolOutputs(compactedHistory);
  const evictedHistory = eviction.messages;
  if (eviction.summary.evictedToolCalls > 0) {
    void logInfo(
      `eviction: collapsed ${eviction.summary.evictedToolCalls} stale read_file output(s), ~${eviction.summary.estimatedTokensSaved} tokens saved`,
    ).catch(() => {});
  }

  // Context pruning: an early span whose work is already saved to git (a
  // successful git_checkpoint / git_commit) is replaced by a short checkpoint
  // summary instead of shipping the full chat. This is the difference between
  // "trim the big tool outputs" (compaction/eviction above) and "don't send
  // the finished work at all". Runs after those so it prunes the smallest,
  // already-trimmed history.
  const prune = pruneVerifiedPrefix(evictedHistory);
  const finalHistory = prune.messages;
  if (prune.pruned) {
    void logInfo(
      `[ai] context prune: ${prune.cutAt} verified message(s) → checkpoint summary (${prune.summary?.length ?? 0} chars)`,
    ).catch(() => {});
    opts.onPrune?.({ prunedMessages: prune.cutAt });
  }

  const prompt = prepareAgentPrompt(
    stableSystem,
    opts.planMode ? PLAN_MODE_PROMPT : null,
    finalHistory,
    provider,
  );

  let stepsSeen = 0;
  let runCost = 0;
  // A hung provider (no first token) used to leave the run on "thinking"
  // forever, unstop-able. Abort the model call if it produces nothing within a
  // generous window; once the first step lands the timer is cleared, so a long
  // legitimate run (e.g. a slow scan, a sub-agent fan-out) is not killed.
  const abortController = new AbortController();
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort(), {
      once: true,
    });
  }
  let firstStepTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    abortController.abort(new Error("model did not respond within 90s"));
  }, 90_000);
  // A provider that accepts the connection and then goes silent looked exactly
  // like one that is merely slow: 90 seconds of dead air with a bare spinner.
  // At 30s without a first token, name the wait in the step label (the HUD
  // reads "Round N · <step>"), so the pause is an explained stall rather than
  // a suspected hang. "Model", not "provider": that is the word users pick in
  // Settings and see in the header; "provider" is our internal plumbing.
  let stallNotice: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    opts.onStep?.("The model is taking a while to respond — still waiting…");
  }, 30_000);
  const clearFirstStepTimer = (): void => {
    if (firstStepTimer) {
      clearTimeout(firstStepTimer);
      firstStepTimer = null;
    }
    if (stallNotice) {
      clearTimeout(stallNotice);
      stallNotice = null;
    }
  };
  // Three guards, any of which ends the loop. Each wrapper records which one
  // tripped first so the UI can explain the stop instead of offering the same
  // blank "continue" for every cause.
  let stopReason: AgentStopReason | null = null;
  // The active harness profile for this workspace adjusts the system prompt,
  // the exposed toolset and the loop budget (see harnessProfile.ts).
  const workspaceRoot = opts.toolContext.getWorkspaceRoot();
  const profile = getProfile(activeProfileIdFor(workspaceRoot));

  const stepBudget = applyProfileToStepBudget(
    opts.stepBudget ?? MAX_AGENT_STEPS,
    profile,
  );
  const costBudget = opts.costBudgetUsd ?? 0;
  const capPred = stepCountIs(stepBudget);
  const repeatPred = noToolRepetition<ToolSet>(3);
  const idlePred = noProgressStop<ToolSet>(2);
  const errorPred = noErrorProgress<ToolSet>(3);

  // Forced-synthesis on a stuck stop. When a guard (step cap, tool loop, no
  // progress) would end the run, the last thing the user saw was usually a
  // repeated tool call and then silence. Instead, give the model ONE final
  // tool-less step to summarise what it found and what remains — `prepareStep`
  // pins `toolChoice: "none"` for that step (see below), and this flag both
  // requests it and then lets the run stop once the summary lands. Gated on the
  // model accepting a forced tool choice (reasoning models reject it).
  const allowSynthesis = modelAllowsForcedToolChoice(info);
  let synthesisRequested = false;
  const requestSynthesisOrStop = (reason: AgentStopReason): boolean => {
    stopReason ??= reason;
    const d = synthesisStopDecision(allowSynthesis, synthesisRequested);
    synthesisRequested = d.requested;
    return d.stop;
  };

  const trackingStopWhen: StopCondition<ToolSet>[] = [
    // Highest priority: the user pressed Stop. End the step loop at the next
    // step boundary even if the model call did not reject — this is what makes
    // Stop reliably halt a looping agent, not only the in-flight round.
    (_args) => {
      if (opts.abortSignal?.aborted) {
        stopReason ??= "aborted";
        return true;
      }
      return false;
    },
    // Next: the user queued a task while this run was working. End at the next
    // step boundary so that task is picked up promptly (a long run no longer
    // blocks it), then resume from here on the following turn. No synthesis
    // step — the queued task is the next thing to do.
    (_args) => {
      if (opts.hasPendingSteer?.()) {
        stopReason ??= "steered";
        return true;
      }
      return false;
    },
    (args) =>
      (capPred(args) as boolean) ? requestSynthesisOrStop("step-cap") : false,
    (args) =>
      (repeatPred(args) as boolean)
        ? requestSynthesisOrStop("tool-repetition")
        : false,
    (args) =>
      (idlePred(args) as boolean)
        ? requestSynthesisOrStop("no-progress")
        : false,
    (args) =>
      (errorPred(args) as boolean)
        ? requestSynthesisOrStop("tool-error")
        : false,
    (_args) => {
      // Cost cap stops immediately — the whole point is to not spend more, so
      // it does not buy an extra synthesis step.
      if (costBudget <= 0) return false;
      const current = estimateCost(modelId, {
        inputTokens: runInput,
        outputTokens: runOutput,
        cachedInputTokens: runCached,
      });
      if (current == null) return false;
      runCost = current;
      if (runCost >= costBudget) {
        stopReason ??= "cost-cap";
        return true;
      }
      return false;
    },
    // Once a synthesis step was requested, stop as soon as the model produces a
    // tool-less (text) step — that is the summary we asked for.
    (args) => {
      if (!synthesisRequested) return false;
      const steps =
        (args as { steps?: Array<{ toolCalls?: unknown[] }> }).steps ?? [];
      const last = steps[steps.length - 1];
      return (last?.toolCalls?.length ?? 0) === 0;
    },
  ];

  const hooksConfig = opts.hooksConfig;
  const rawTools = {
    ...(opts.mcpTools ?? {}),
    ...(opts.extensionTools ?? {}),
    ...(opts.customTools ?? {}),
    ...buildTools({
      ...opts.toolContext,
      firePreToolHook: hooksConfig
        ? async (toolName, args) => {
            await fireHooksForEvent(
              hooksConfig,
              "PreToolUse",
              toolName,
              { args },
              {
                getWorkspaceRoot: opts.toolContext.getWorkspaceRoot,
                getCwd: opts.toolContext.getCwd,
                makeRunId: () =>
                  opts.runId ?? makeRunId(opts.toolContext.getSessionId()),
              },
            );
          }
        : undefined,
      firePostToolHook: hooksConfig
        ? async (toolName, args, result) => {
            await fireHooksForEvent(
              hooksConfig,
              "PostToolUse",
              toolName,
              { args, result },
              {
                getWorkspaceRoot: opts.toolContext.getWorkspaceRoot,
                getCwd: opts.toolContext.getCwd,
                makeRunId: () =>
                  opts.runId ?? makeRunId(opts.toolContext.getSessionId()),
              },
            );
          }
        : undefined,
    }),
  };
  // Reorder/hide tools per the active harness profile (see harnessProfile.ts).
  // Main agent passes no depth, so its spawn tools are never withheld — the
  // same context-safe injection a sub-agent goes through, minus the nesting cap.
  const tools = buildAgentTools(rawTools, { profile });

  // What the model is handed before it reads a word of the request. Measured
  // as components rather than one number: a total says "slow", a breakdown
  // says which addition made it slow. `system` here is the base prompt plus
  // skills, persona and custom instructions - project and learned memory are
  // reported separately even though they live inside it, so the two that grow
  // on their own are visible on their own.
  const projectBytes = opts.projectMemory?.length ?? 0;
  const learnedBytes = learnedBlock(opts.learnedMemory ?? []).length;
  const systemTotal = prompt.system.reduce(
    (n: number, m: { content: unknown }) => n + String(m.content).length,
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
  // which is far better than losing the request. The static tag check only
  // covers the built-in registry — a custom endpoint that rejected the pin on
  // an earlier round (learned in toolChoiceLearning) is honoured here too.
  const forceFanout =
    "run_subagents" in tools &&
    modelAllowsForcedToolChoice(info) &&
    !modelRejectsForcedToolChoice(modelId) &&
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

  // The trajectory store records every tool call this run makes, so the
  // timeline and reasoning HUD have real data instead of an empty state.
  // A fresh id per run keeps consecutive runs separate in the store.
  const trajectoryRunId = `run-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const trajectory = useTrajectoryStore.getState();
  trajectory.startRun({ runId: trajectoryRunId, modelId });
  let trajectoryStepIndex = 0;

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

  logInfo(
    `[ai] runAgentStream: before streamText (${Object.keys(tools).length} tools)`,
  );
  // Apply the harness profile's prompt prelude (if any) to the base system.
  const baseSystem = applyProfileToSystem(prompt.system, profile);
  const sessionId = opts.toolContext.getSessionId();
  return streamText({
    model,
    system: baseSystem,
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
    // Repair tool-call arguments that a provider (e.g. StepFun via the
    // OpenAI-compatible endpoint) emits as near-JSON, so a recoverable input
    // runs instead of hard-failing with "Invalid input for tool".
    experimental_repairToolCall: repairToolCall as never,
    // Per-step choice control: a stuck run's final step is pinned tool-less so
    // the model must summarise (see `synthesisRequested`); the forced-fanout
    // case pins step 0 to `run_subagents`. Every other step is free. The
    // system prompt is also refreshed each step with the live todo list, so the
    // model is reminded at every tool decision what is done / in progress —
    // the mechanical nudge that gets items checked off as they finish instead
    // of being left stale until the end.
    prepareStep: ({ stepNumber }: { stepNumber: number }) => {
      const toolChoice = synthesisRequested
        ? ("none" as const)
        : forceFanout && stepNumber === 0
          ? ({ type: "tool", toolName: "run_subagents" } as const)
          : undefined;
      const todos =
        sessionId != null
          ? (useTodosStore.getState().bySession[sessionId]?.items ?? [])
          : [];
      const todoBlock = formatTodoStatusBlock(todos);
      // When there is a live todo list the system gets the todo block appended
      // as a system message so the model sees live progress every step;
      // otherwise the (profile-applied) system is used untouched.
      const system = todoBlock
        ? appendSystemHint(baseSystem, todoBlock)
        : baseSystem;
      return { toolChoice, system };
    },
    abortSignal: abortController.signal,
    // Clear the "no first response" timer on the first model chunk (a text
    // delta or a tool-call decision), NOT on step finish. A step that starts
    // with a long tool (e.g. a 90s nmap scan) keeps the run alive for the
    // whole tool execution; the timer only exists to catch a provider that
    // never produces a first token.
    onChunk: () => {
      clearFirstStepTimer();
    },
    onStepFinish: (step) => {
      clearFirstStepTimer();
      logInfo(`[ai] runAgentStream: step finished (#${stepsSeen})`);
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

      // Record each tool invocation in the trajectory store. By the time
      // onStepFinish fires the results for this step are already in, so each
      // call is appended with its final status and output rather than being
      // flipped from pending later.
      const calls = step.toolCalls ?? [];
      if (calls.length > 0) {
        const traj = useTrajectoryStore.getState();
        const resultsByCallId = new Map<
          string,
          { output: unknown; failed: boolean }
        >();
        // A failed call (schema-validation reject, thrown execute) lands as a
        // `tool-error` part: it carries `.error`, not `.output`. Reading only
        // `.output` made those calls look "resultless", so their card either
        // went green (hasResult true, error invisible) or stayed RUNNING
        // forever when the round died mid-flight — a dead card the user
        // mistook for a question awaiting their click.
        for (const r of step.toolResults ?? []) {
          const res = r as {
            type?: string;
            toolCallId?: string;
            output?: unknown;
            error?: unknown;
          };
          if (!res.toolCallId) continue;
          resultsByCallId.set(res.toolCallId, {
            output: res.output,
            failed: res.type === "tool-error" || res.error != null,
          });
        }
        for (const call of calls) {
          const c = call as {
            toolCallId?: string;
            toolName: string;
            input?: unknown;
          };
          const hit = c.toolCallId
            ? resultsByCallId.get(c.toolCallId)
            : undefined;
          const hasResult =
            c.toolCallId != null && resultsByCallId.has(c.toolCallId);
          const output = hit?.output;
          // Tools signal failure by returning `{ error }` rather than throwing,
          // so that shape is what marks a step red in the timeline.
          const isError =
            hit?.failed === true ||
            (output != null &&
              typeof output === "object" &&
              "error" in (output as Record<string, unknown>));
          traj.appendStep({
            id: `${trajectoryRunId}-s${trajectoryStepIndex}`,
            stepIndex: trajectoryStepIndex,
            toolName: c.toolName,
            args: (c.input ?? {}) as Record<string, unknown>,
            status: hasResult ? (isError ? "error" : "success") : "running",
            output,
          });
          trajectoryStepIndex++;
        }
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
        estimatedCostUsd: runCost || null,
        costBudgetUsd: costBudget,
        at: Date.now(),
      };
      opts.onFinishMeta?.({ stopReason: settledStop, finishReason, metrics });

      // Close out the trajectory run. An early stop by a guard is a failed run in
      // the timeline's vocabulary; a clean finish is completed.
      useTrajectoryStore.getState().finishRun({
        status: settledStop ? "failed" : "completed",
        totalTokens: runInput + runOutput,
        totalCostUsd: runCost > 0 ? runCost : undefined,
      });

      // A clean finish means the model decided it was done (its last step was a
      // summary, no more tools). If it forgot to check off the items it began —
      // the one it was actively working on, and any earlier ones it neglected —
      // mark them complete now so the todo list reflects the run instead of
      // leaving everything unchecked. Items it never started (still `pending`)
      // are left alone, because the model may legitimately judge some of the
      // plan out of scope. This is the fallback BatikCode's todo tracking relies
      // on: the model is nudged every step, and when it still forgets, the clean
      // finish closes the gap rather than leaving a stale checklist.
      if (!settledStop) {
        const sessionId = opts.toolContext.getSessionId();
        if (sessionId) useTodosStore.getState().completeStarted(sessionId);
      }

      // Feed this run's outcome into the harness frontier so the best profile
      // for this workspace can be learned over time (see harnessFrontier.ts).
      if (workspaceRoot) {
        void recordRun(workspaceRoot, profile.id, {
          success: !settledStop,
          steps: stepsSeen,
        }).catch(() => {});
      }

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
    // An abort with zero completed steps never reaches onFinish: the SDK has
    // nothing to report, so the trajectory run would stay "running" forever.
    // onAbort fires on exactly that path and closes it out. finishRun ignores
    // a run that is already finished, so the two callbacks cannot fight.
    onAbort: () => {
      opts.onStep?.(null);
      useTrajectoryStore.getState().finishRun({
        status: "aborted",
        totalTokens: runInput + runOutput,
        totalCostUsd: runCost > 0 ? runCost : undefined,
      });
    },
  });
}

export { EMPTY_USAGE };
