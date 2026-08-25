import type { UIMessage } from "@ai-sdk/react";
import { readMemory } from "./memory";
import { getMcpTools } from "./mcpTools";
import { listSkills } from "./skills";
import { hydrateInvariants } from "../tools/invariant";
import { buildExtensionTools } from "./extensionTools";
import { buildCustomTools, loadCustomTools } from "./customToolsIo";
import type { CustomEndpoint } from "../config";
import {
  runAgentStream,
  type AgentStopReason,
  type AgentUsageDelta,
  type RunDiagnostics,
} from "./agent";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { formatAiError } from "./errors";
import { error as logError } from "@tauri-apps/plugin-log";
import { native } from "./native";
import type { ToolContext } from "../tools/tools";

/**
 * How much of `TERMIGO.md` reaches the model.
 *
 * Project memory is part of the system prompt, so it is paid on every request
 * and in full on the first one, where nothing is cached yet. This repo's own
 * file is 30 KB - about 7,700 tokens spent before the user has typed anything,
 * and the largest single reason the first answer is slow.
 *
 * 10 KB keeps the top of the document, which is where an architecture note
 * puts its overview, and drops the reference detail further down. The agent
 * can still read the file with `read_file` when it needs the rest; what it
 * loses is having all of it memorised up front.
 *
 * Counted in characters, not bytes: `String.length` is UTF-16 code units. The
 * two only diverge on non-ASCII text, and this is prose about code, but the
 * old name said bytes and the check said characters.
 */
export const TERMIGO_MD_MAX_CHARS = 10 * 1024;

type MemoryCacheEntry = { content: string | null; mtime: number };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();

/// Show the failure in the chat and also record it in the app log.
///
/// AI requests fail in the webview, so nothing about them ever reached
/// `logs/Termigo.log` - which records only the Rust side. A user whose run
/// died mid-stream had to catch the message on screen before it scrolled
/// away, and if they missed it there was no trace left to report.
///
/// Logs the formatted text rather than the raw error on purpose:
/// `formatAiError` has already stripped bearer tokens and API keys, and the
/// raw value carries the request headers that hold them.
function logAndFormatAiError(error: unknown): string {
  const message = formatAiError(error);
  // Fire-and-forget: a failing logger must not replace the error the user
  // is waiting to see.
  void logError(`ai request failed: ${message}`).catch(() => {});
  return message;
}

/**
 * Cut project memory to the budget at a line boundary, and say so.
 *
 * A blind slice ends mid-sentence, which reads to the model as a fact that
 * stops halfway rather than a document that was cut. Saying it was truncated
 * also tells the agent the rest exists and can be read.
 */
export function truncateProjectMemory(content: string): string {
  if (content.length <= TERMIGO_MD_MAX_CHARS) return content;
  const cut = content.slice(0, TERMIGO_MD_MAX_CHARS);
  const lastBreak = cut.lastIndexOf("\n");
  // A file with no newline in the budget has nothing better to cut on.
  const body = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  return `${body}\n\n[TERMIGO.md truncated here; read the file for the rest]`;
}

async function readTermigoMd(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/TERMIGO.md`;
  const cached = projectMemoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
      return null;
    }
    const content = truncateProjectMemory(r.content);
    projectMemoryCache.set(workspaceRoot, { content, mtime: Date.now() });
    return content;
  } catch {
    projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
    return null;
  }
}

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
};

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => string;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  getLmstudioBaseURL?: () => string | undefined;
  getLmstudioModelId?: () => string | undefined;
  getMlxBaseURL?: () => string | undefined;
  getMlxModelId?: () => string | undefined;
  getOllamaBaseURL?: () => string | undefined;
  getOllamaModelId?: () => string | undefined;
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  getOpenaiCompatibleModelId?: () => string | undefined;
  getOpenaiCompatibleContextLimit?: () => number | undefined;
  getOpenrouterModelId?: () => string | undefined;
  getCustomEndpoints?: () => readonly CustomEndpoint[];
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onRemember?: (info: { fact: string }) => void;
  onFinishMeta?: (info: {
    stopReason: AgentStopReason | null;
    finishReason: string;
    metrics: RunDiagnostics;
  }) => void;
  getPlanMode?: () => boolean;
  getStepBudget?: () => number;
  getCostBudgetUsd?: () => number;
  getCaptureDebug?: () => boolean;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    // Timed because "the first message is slow" has had four plausible causes
    // and no measurement. This block runs before a single token reaches the
    // model: project memory, learned memory, MCP servers, skills and custom
    // tools. MCP is the one that can start a process, so it is the one that
    // can turn a file read into twenty seconds.
    const contextStart = performance.now();
    const [projectMemory, learnedMemory, mcpTools, skills, customDefs] = await Promise.all([
      readTermigoMd(live.workspaceRoot),
      readMemory(live.workspaceRoot),
      getMcpTools(live.workspaceRoot),
      listSkills(live.workspaceRoot),
      loadCustomTools(live.workspaceRoot),
      // Loads `.termigo/invariants.json` into the invariant module so the
      // system prompt assembled inside runAgentStream sees every pinned
      // constraint, including ones pinned in earlier sessions.
      hydrateInvariants(live.workspaceRoot),
    ]);
    const contextMs = performance.now() - contextStart;
    const envBlock = formatEnvBlock(live);
    const messagesForRun = prepareOutgoingMessages(options.messages, envBlock);
    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      customInstructions: deps.getCustomInstructions(),
      learnedMemory,
      mcpTools,
      skills,
      // Read at send time, not cached: extensions are enabled, disabled and
      // reloaded while the app is open.
      extensionTools: buildExtensionTools(),
      customTools: buildCustomTools(customDefs, {
        getRemoteSession: () => deps.toolContext.getRemoteSession(),
        getCwd: () => deps.toolContext.getCwd(),
        runLocal: (command, cwd) =>
          native.runCommand(command, cwd ?? undefined, 300),
      }),
      agentPersona: deps.getAgentPersona(),
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onRemember: deps.onRemember,
      onFinishMeta: deps.onFinishMeta,
      lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
      lmstudioModelId: deps.getLmstudioModelId?.(),
      mlxBaseURL: deps.getMlxBaseURL?.(),
      mlxModelId: deps.getMlxModelId?.(),
      ollamaBaseURL: deps.getOllamaBaseURL?.(),
      ollamaModelId: deps.getOllamaModelId?.(),
      openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
      openaiCompatibleModelId: deps.getOpenaiCompatibleModelId?.(),
      openaiCompatibleContextLimit: deps.getOpenaiCompatibleContextLimit?.(),
      openrouterModelId: deps.getOpenrouterModelId?.(),
      customEndpoints: deps.getCustomEndpoints?.(),
      customEndpointKeys: deps.getCustomEndpointKeys?.(),
      planMode: deps.getPlanMode?.(),
      stepBudget: deps.getStepBudget?.(),
      costBudgetUsd: deps.getCostBudgetUsd?.(),
      captureDebug: deps.getCaptureDebug?.(),
      contextMs,
      projectMemory,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
    });
    return result.toUIMessageStream({
      originalMessages: options.messages,
      onError: logAndFormatAiError,
    });
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}

/**
 * Append the environment as its own trailing turn.
 *
 * It used to be prepended into the last user message, which quietly destroyed
 * prefix caching. The block goes onto the outgoing copy, never into stored
 * history, so the message that carried it on one turn arrives without it on
 * the next:
 *
 *   turn N     [system, u1+env]
 *   turn N+1   [system, u1, a1, u2+env]      <- u1 no longer matches
 *
 * Providers cache on an exact token prefix, so a difference at `u1` invalidates
 * everything after it. Every turn re-processed the whole conversation, and only
 * the system prompt survived - the opposite of what the cache is for.
 *
 * As a trailing turn the history stays byte-identical across requests and the
 * only part that changes is last, where a change costs nothing. It has to be
 * last for the same reason it could not be a second system message: anything
 * before the history would invalidate the history.
 */
/**
 * Whether the run is resuming a tool call the user has just approved.
 *
 * This decides whether the environment turn may be appended, because the SDK
 * finds approvals in exactly one place:
 *
 *     const lastMessage = messages.at(-1);
 *     if (lastMessage?.role != "tool") return { approvedToolApprovals: [] };
 *
 * `convertToModelMessages` turns an answered approval into a trailing `tool`
 * message carrying the response. Appending the env block put a `user` message
 * after it, so `streamText` found no approvals, never executed the call, and
 * forwarded an assistant `tool_calls` with nothing answering it - which is the
 * provider's "must be followed by tool messages responding to each
 * tool_call_id" rejection, reported as a failure of the command the user had
 * just approved.
 *
 * Only the approval resume is held back. An ordinary continuation already ends
 * in a `tool` message full of results, where a trailing user turn changes
 * nothing, and the env block is refreshed on the user's next real turn anyway.
 */
export function isResumingApproval(messages: readonly UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return false;
  return last.parts.some(
    (part: unknown) =>
      (part as { state?: string }).state === "approval-responded",
  );
}

/**
 * The stored history turned into the copy that goes out on the wire.
 *
 * One function rather than three lines inline in `run`, because what it decides
 * is an invariant the provider enforces and nothing else checks: the shape of
 * the last message. `approvalResume.test.ts` runs this the whole way to model
 * messages, which is where the seam that broke actually lives.
 */
export function prepareOutgoingMessages(
  messages: UIMessage[],
  envBlock: string | null,
): UIMessage[] {
  if (!envBlock) return messages;
  if (isResumingApproval(messages)) return messages;
  return appendEnvTurn(messages, envBlock);
}

export function appendEnvTurn(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  return [
    ...messages,
    {
      id: `env-${messages.length}`,
      role: "user",
      parts: [{ type: "text", text: envBlock }],
    } as UIMessage,
  ];
}

function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
