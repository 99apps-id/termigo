import { IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { UIMessage } from "@ai-sdk/react";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import type { CustomEndpoint } from "../config";
import { hydrateInvariants } from "../tools/invariant";
import type { ToolContext } from "../tools/tools";
import {
  type AgentStopReason,
  type AgentUsageDelta,
  type RunDiagnostics,
  runAgentStream,
} from "./agent";
import { costToday } from "./costLedger";
import { buildCustomTools, loadCustomTools } from "./customToolsIo";
import { formatAiError } from "./errors";
import { buildExtensionTools } from "./extensionTools";
import type { HooksConfig } from "./hooks";
import { loadHooks } from "./hooksIo";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import { getMcpTools } from "./mcpTools";
import { readMemory } from "./memory";
import { native } from "./native";
import { listSkills } from "./skills";
import { autoCheckpointForRun } from "./snapshots";
import { formatTodoStatusBlock } from "./todos";

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

async function readTermigoMd(
  workspaceRoot: string | null,
): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/TERMIGO.md`;
  const cached = projectMemoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(workspaceRoot, {
        content: null,
        mtime: Date.now(),
      });
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
  goal: string | null;
  schedules: { when: string; prompt: string; enabled: boolean }[];
  todos: { title: string; status: "pending" | "in_progress" | "completed" }[];
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
  /** Fires at the start of every agentic-loop round (each `sendMessages`), so
   *  the UI can surface "Round N" and a user can tell a run is progressing. */
  onRoundStart?: () => void;
  /** Returns true when a round for this session should be refused — used to
   *  carry a user Stop across to the next auto-continue round (which is
   *  dispatched by the SDK directly, bypassing the user send path). */
  shouldRefuseRun?: (sessionId: string) => boolean;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  /** An early, verified span of the transcript was replaced by a checkpoint
   *  summary before this request was sent. */
  onPrune?: (info: { prunedMessages: number }) => void;
  onRemember?: (info: { fact: string }) => void;
  onFinishMeta?: (info: {
    stopReason: AgentStopReason | null;
    finishReason: string;
    metrics: RunDiagnostics;
  }) => void;
  getPlanMode?: () => boolean;
  getStepBudget?: () => number;
  getCostBudgetUsd?: () => number;
  getCostDailyBudgetUsd?: () => number;
  getCaptureDebug?: () => boolean;
  getAutoCheckpoint?: () => boolean;
  getHooksConfig?: () => HooksConfig;
  getRunId?: () => string;
  /** How many messages are queued for the active session right now. The run
   *  records this at its start and yields at the next step only when the count
   *  GROWS — i.e. a task typed while THIS run worked — so tasks already waiting
   *  (delivered one at a time on settle) do not make each run bail immediately. */
  getSteerCount?: () => number;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

export function createContextAwareTransport(deps: Deps) {
  // A context-assembly stall (a hung MCP server start, a file read that never
  // returns) would otherwise leave the run on "thinking" forever with no way
  // to stop it, because the abort signal only reaches the model call later.
  const CONTEXT_TIMEOUT_MS = 60_000;
  // The pre-run git checkpoint can hang on a huge or misconfigured repo — e.g.
  // when a workspace switch fell back to the home directory. Bound it hard so it
  // can never freeze the run before the model is even called.
  const CHECKPOINT_TIMEOUT_MS = 12_000;
  const withTimeout = <T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`${label} timed out after ${Math.round(ms / 1000)}s`),
          ),
        ms,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const isAbort = (e: unknown): boolean =>
    e instanceof DOMException
      ? e.name === "AbortError"
      : !!e &&
        typeof e === "object" &&
        (e as { name?: string }).name === "AbortError";
  // Reject as soon as the user hits Stop, even while a pre-stream await (the
  // checkpoint, context assembly) is still in flight — that is what makes Stop
  // responsive before the model call, where the abort signal used to first bite.
  const raceAbort = <T>(
    promise: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted)
      return Promise.reject(new DOMException("aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  };

  const run = async (options: SendOptions) => {
    logInfo(`[ai] run: start (${options.messages.length} messages)`);
    // A stop latched for this session refuses the SDK's auto-continue round,
    // which is dispatched directly (not via sendParts). This is what makes a
    // pressed Stop end the loop even when it lands between rounds.
    if (deps.shouldRefuseRun?.(String(options.chatId))) {
      throw new DOMException("aborted", "AbortError");
    }
    deps.onRoundStart?.();
    const live = deps.getLive();
    // Baseline the queue so the run yields only to a task typed WHILE it runs,
    // not to tasks already waiting (which are delivered one at a time on settle).
    const steerBaseline = deps.getSteerCount?.() ?? 0;
    // Daily budget guardrail: refuse to start a run once today's recorded
    // spend reaches the limit. Checked before any context is assembled so a
    // blocked run costs nothing at all. 0 means unlimited.
    const dailyBudget = deps.getCostDailyBudgetUsd?.() ?? 0;
    if (dailyBudget > 0) {
      const spentToday = await costToday();
      if (spentToday >= dailyBudget) {
        throw new Error(
          `Daily cost budget reached: $${spentToday.toFixed(4)} spent today, ` +
            `budget is $${dailyBudget.toFixed(2)}. Raise the daily budget in ` +
            "Settings > Agents, or wait for tomorrow.",
        );
      }
    }
    // Workspace snapshot guardrail: checkpoint the working tree before the
    // run starts, so a bad run can be rolled back from the checkpoint
    // timeline. Skipped on approval resumes because those continue a run that
    // is already in flight, and a checkpoint mid-run would capture the
    // agent's own half-finished edits as the "safe" state.
    // Already stopped before we even began — bail without touching git or the
    // model.
    if (options.abortSignal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (
      deps.getAutoCheckpoint?.() &&
      !isResumingApproval(options.messages) &&
      !deps.toolContext.getRemoteSession()
    ) {
      // Bounded + abortable + non-fatal: a slow/huge repo (or the home directory
      // after a workspace fallback) must not hang the run or ignore Stop. A
      // timeout or git error just skips the checkpoint; only an abort stops.
      try {
        await raceAbort(
          withTimeout(
            autoCheckpointForRun(live.workspaceRoot),
            CHECKPOINT_TIMEOUT_MS,
            "checkpoint",
          ),
          options.abortSignal,
        );
      } catch (e) {
        if (isAbort(e)) throw e;
        logInfo(`[ai] run: checkpoint skipped (${String(e)})`);
      }
    }
    // Timed because "the first message is slow" has had four plausible causes
    // and no measurement. This block runs before a single token reaches the
    // model: project memory, learned memory, MCP servers, skills and custom
    // tools. MCP is the one that can start a process, so it is the one that
    // can turn a file read into twenty seconds.
    const contextStart = performance.now();
    const [projectMemory, learnedMemory, mcpTools, skills, customDefs] =
      await raceAbort(
        withTimeout(
          Promise.all([
            readTermigoMd(live.workspaceRoot),
            readMemory(live.workspaceRoot),
            getMcpTools(live.workspaceRoot),
            listSkills(live.workspaceRoot),
            loadCustomTools(live.workspaceRoot),
            loadHooks(live.workspaceRoot),
            hydrateInvariants(live.workspaceRoot),
          ]),
          CONTEXT_TIMEOUT_MS,
          "context assembly",
        ),
        options.abortSignal,
      );
    const contextMs = performance.now() - contextStart;
    const envBlock = formatEnvBlock(live);
    const messagesForRun = prepareOutgoingMessages(options.messages, envBlock);
    logInfo(
      `[ai] run: context assembled in ${contextMs.toFixed(0)}ms (${messagesForRun.length} msgs)`,
    );
    logInfo(`[ai] run: calling runAgentStream`);
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
      onPrune: deps.onPrune,
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
      hooksConfig: deps.getHooksConfig?.(),
      runId: deps.getRunId?.(),
      contextMs,
      projectMemory,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
      hasPendingSteer: () => (deps.getSteerCount?.() ?? 0) > steerBaseline,
    });
    logInfo(`[ai] run: stream created`);
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
  // OS + shell so the model writes commands for the RIGHT shell. Without this
  // a model kept emitting cmd/DOS syntax into PowerShell (`2>nul`, `dir /s /b`),
  // which errors, and recursive scans from a huge home dir that time out.
  const wsEnv = currentWorkspaceEnv();
  if (wsEnv.kind === "wsl") {
    lines.push(`os: Linux (WSL: ${wsEnv.distro})`);
    lines.push("shell: bash/sh — POSIX syntax, forward slashes");
  } else if (IS_WINDOWS) {
    lines.push("os: Windows");
    lines.push(
      "shell: PowerShell — use PowerShell syntax, NOT cmd/DOS: `2>$null` not `2>nul`, `Get-ChildItem` not `dir /s /b`. To find files use the `glob` tool, not `Get-ChildItem -Recurse` from a large dir (it scans node_modules/AppData and times out).",
    );
  } else {
    lines.push(`os: ${IS_MAC ? "macOS" : "Linux"}`);
    lines.push("shell: /bin/sh — POSIX syntax");
  }
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (live.goal) lines.push(`goal: ${live.goal}`);
  if (live.schedules.length > 0) {
    lines.push("schedules:");
    for (const s of live.schedules) {
      lines.push(`  - ${s.enabled ? "" : "(paused) "}${s.when}: ${s.prompt}`);
    }
  }
  // Current todo list with live status. Seen every turn, it is a standing
  // reminder to check items off as you finish them (todo_write), instead of
  // leaving the list stale until the end.
  const todoBlock = formatTodoStatusBlock(live.todos);
  if (todoBlock) lines.push(todoBlock);
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
