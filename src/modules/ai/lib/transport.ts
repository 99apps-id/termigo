import type { UIMessage } from "@ai-sdk/react";
import { readMemory } from "./memory";
import { getMcpTools } from "./mcpTools";
import { listSkills } from "./skills";
import { buildExtensionTools } from "./extensionTools";
import { buildCustomTools, loadCustomTools } from "./customToolsIo";
import type { CustomEndpoint } from "../config";
import {
  runAgentStream,
  type AgentStopReason,
  type AgentUsageDelta,
} from "./agent";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { formatAiError } from "./errors";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
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
 */
const TERMIGO_MD_MAX_BYTES = 10 * 1024;
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
  if (content.length <= TERMIGO_MD_MAX_BYTES) return content;
  const cut = content.slice(0, TERMIGO_MD_MAX_BYTES);
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
  onFinishMeta?: (info: {
    stopReason: AgentStopReason | null;
    finishReason: string;
  }) => void;
  getPlanMode?: () => boolean;
  getStepBudget?: () => number;
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
    ]);
    void logInfo(
      `context assembled in ${Math.round(performance.now() - contextStart)}ms ` +
        `(mcp tools: ${Object.keys(mcpTools).length}, skills: ${skills.length})`,
    ).catch(() => {});
    const envBlock = formatEnvBlock(live);
    const messagesForRun = envBlock
      ? appendEnvTurn(options.messages, envBlock)
      : options.messages;
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
      captureDebug: deps.getCaptureDebug?.(),
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
