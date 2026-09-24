// Loop breaker for the SDK's automatic approval resume.
//
// `Chat` re-sends by itself when the last assistant message carries answered
// approvals (`sendAutomaticallyWhen`). That is correct for one resume, and it is
// unbounded: nothing in the SDK counts how many times it has already done it. A
// model that re-requests the same approval every cycle therefore keeps the run
// alive forever, and the only existing guard (`approvalResumeFailureCount`)
// counts FAILED resumes, so a loop whose cycles all succeed is not bounded at
// all.
//
// Observed in the field: repeated `run: start (14 messages)` with
// `steps 1/25 | stop tool-calls` every few seconds. The message count never
// moved and `runRound` stayed 0, because an SDK auto-send does not go through
// the step-budget ladder - so the run was not making progress, it was repeating.
//
// The signal that separates the two is PROGRESS: a legitimate resume adds
// productive work (successful mutations, new reads, user text) to the transcript.
// A repeating or failing cycle does not. This module guards against stalled runs,
// repeated identical tool calls across rounds, and consecutive tool execution errors.

/** Consecutive automatic sends that added nothing before the run is stopped. */
export const MAX_STALLED_AUTO_SENDS = 5;

/** Maximum times an identical tool call may repeat across auto-sends before stopping. */
export const MAX_AUTO_SEND_TOOL_REPEATS = 3;

/** Maximum consecutive tool execution errors allowed before stopping. */
export const MAX_CONSECUTIVE_AUTO_SEND_ERRORS = 3;

/** Maximum total automatic sends allowed in a single task turn before stopping. */
export const MAX_TOTAL_AUTO_SENDS = 10;

export type ExtractedToolCall = {
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  isError: boolean;
  hasResult: boolean;
  state?: string;
};

export type AutoSendGateState = {
  /** Progress at the last allowed automatic send. */
  lastProgress: number;
  /** How many automatic sends in a row have added nothing. */
  stalled: number;
  /** Fingerprint of the last repeating tool call if detected. */
  lastToolFingerprint?: string | null;
  /** Total number of automatic sends allowed during this task turn. */
  totalAutoSends?: number;
};

export const INITIAL_AUTO_SEND_STATE: AutoSendGateState = {
  lastProgress: 0,
  stalled: 0,
  totalAutoSends: 0,
};

export type AutoSendGateOptions = {
  maxStalled?: number;
  maxToolRepeats?: number;
  maxConsecutiveErrors?: number;
  maxTotalAutoSends?: number;
  recentToolCalls?: ExtractedToolCall[];
};

export type AutoSendDecision = {
  /** Whether the automatic send may proceed. */
  allow: boolean;
  /** State to keep for the next decision. */
  state: AutoSendGateState;
  /** True when this decision stopped a repeating run. */
  stoppedLoop: boolean;
  /** Human-readable explanation when a loop was stopped. */
  reason?: string;
};

/** True when a tool output indicates an error or failure rather than data. */
export function isToolCallError(output: unknown): boolean {
  if (output == null || typeof output !== "object") return false;
  const record = output as Record<string, unknown>;
  if (record.error) return true;
  if (record.isError === true) return true;
  if (record.noReadableText === true) return true;
  if (record.isOffline === true) return true;
  if (
    typeof record.text === "string" &&
    record.text.startsWith("(no readable text returned from the page")
  ) {
    return true;
  }
  const code = record.exit_code;
  if (typeof code === "number" && code !== 0) return true;
  if (record.timed_out === true) return true;
  return false;
}

/** Stable serialization for tool inputs so key ordering does not affect comparisons. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** Canonical fingerprint for a tool call. */
export function canonicalToolFingerprint(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input)}`;
}

/** Human-friendly short summary of a tool's target input. */
export function summarizeInput(toolName: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.path === "string" && o.path.trim().length > 0) {
      const parts = o.path.replace(/\\/g, "/").split("/");
      return parts.pop() || o.path;
    }
    if (typeof o.command === "string" && o.command.trim().length > 0) {
      return `"${o.command.slice(0, 30)}"`;
    }
    if (typeof o.query === "string" && o.query.trim().length > 0) {
      return `"${o.query.slice(0, 30)}"`;
    }
  }
  return toolName;
}

export const ALWAYS_MUTATING_TOOLS = new Set([
  "edit",
  "write_file",
  "multi_edit",
  "replace_file_content",
  "terminal_write",
  "git_commit",
  "git_push",
  "git_revert",
  "git_reset",
  "git_stash",
]);

const SHELL_MUTATION_RE =
  /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci|add|remove|uninstall|update|upgrade|prune|rebuild|dedupe|link|unlink)\b|pnpm\s*$|yarn\s*$|pip3?\s+install\b|uv\s+(?:sync|add|remove|pip\s+install)\b|poetry\s+(?:install|add|remove|update)\b|cargo\s+(?:add|install|remove|build)\b|go\s+build\b|make\b|cmake\b|rm|del|erase|rmdir|mkdir|md|touch|cp|copy|mv|move|rename|ren|truncate|Set-Content|Add-Content|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Clear-Content|git\s+(?:commit|push|revert|reset|stash|merge|rebase|checkout|switch|clean|cherry-pick|pull)\b|sed\s+-i\b|Out-File|tee\b)/i;

/** Redirection to a file: > or >> not targeting null/nul devices */
export function hasFileRedirection(cmd: string): boolean {
  const sanitized = cmd
    .replace(/>\s*(?:\/dev\/null|nul)\b/gi, "")
    .replace(/2>&1/g, "")
    .replace(/2>\s*(?:\/dev\/null|nul)\b/gi, "");
  return />|>>/.test(sanitized);
}

/**
 * Determine whether a tool call mutates workspace files or environment state.
 * Read-only inspections (cat, grep, git status/diff, tsc, node -e reads) return false.
 */
export function isMutatingToolCall(toolName: string, input: unknown): boolean {
  if (ALWAYS_MUTATING_TOOLS.has(toolName)) return true;
  if (toolName === "bash_run" || toolName === "bash_background") {
    let cmd = "";
    if (typeof input === "string") {
      cmd = input;
    } else if (input && typeof input === "object") {
      const o = input as Record<string, unknown>;
      if (typeof o.command === "string") {
        cmd = o.command;
      }
    }
    if (!cmd.trim()) return false;
    if (hasFileRedirection(cmd)) return true;
    return SHELL_MUTATION_RE.test(cmd);
  }
  return false;
}

/**
 * Extract recent tool calls from the transcript, focusing on the current task turn
 * (starting at the last user message).
 */
export function extractRecentTranscriptToolCalls(
  messages: Array<{ role?: string; parts?: unknown[] }>,
  maxCalls = 20,
): ExtractedToolCall[] {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      startIndex = i;
      break;
    }
  }

  const calls: ExtractedToolCall[] = [];
  const targetMessages = messages.slice(startIndex);

  const resultsByCallId = new Map<
    string,
    { output: unknown; error: unknown; isError: boolean }
  >();

  for (const m of targetMessages) {
    for (const p of (m.parts ?? []) as Record<string, unknown>[]) {
      if (p.type === "tool-result" && typeof p.toolCallId === "string") {
        const isErr =
          isToolCallError(p.output) || Boolean(p.error) || p.isError === true;
        resultsByCallId.set(p.toolCallId, {
          output: p.output,
          error: p.error,
          isError: isErr,
        });
      }
    }
  }

  for (const m of targetMessages) {
    for (const p of (m.parts ?? []) as Record<string, unknown>[]) {
      const type = typeof p.type === "string" ? p.type : "";
      if (type === "tool-call") {
        const toolName = typeof p.toolName === "string" ? p.toolName : "";
        const input = p.input ?? p.args;
        const callId = typeof p.toolCallId === "string" ? p.toolCallId : "";
        const standaloneRes = callId ? resultsByCallId.get(callId) : undefined;
        const output = p.output ?? standaloneRes?.output;
        const error = p.error ?? standaloneRes?.error;
        const isError =
          standaloneRes?.isError ??
          (isToolCallError(output) || Boolean(error) || p.isError === true);
        const hasResult =
          output !== undefined ||
          error !== undefined ||
          standaloneRes !== undefined ||
          p.state === "output-available";
        calls.push({ toolName, input, output, error, isError, hasResult });
      } else if (
        type.startsWith("tool-") &&
        type !== "tool-approval-request" &&
        type !== "tool-approval-response" &&
        type !== "tool-result"
      ) {
        const toolName =
          typeof p.toolName === "string" ? p.toolName : type.slice(5);
        const input = p.input ?? p.args;
        const output = p.output;
        const error = p.error;
        const isError =
          isToolCallError(output) || Boolean(error) || p.isError === true;
        const hasResult =
          output !== undefined ||
          error !== undefined ||
          p.state === "output-available";
        calls.push({ toolName, input, output, error, isError, hasResult });
      }
    }
  }

  return calls.slice(-maxCalls);
}

/**
 * Compute productive forward progress from transcript messages.
 *
 * Real progress includes:
 * - User-visible assistant text parts.
 * - Successful tool results (not errored).
 * - Read tools with unique inputs (duplicate reads without intervening mutations do not count).
 * Errored tool calls and metadata parts (approvals, step-starts, reasoning) add zero progress.
 */
export function computeTranscriptProductiveProgress(
  messages: Array<{ role?: string; parts?: unknown[] }>,
): number {
  let progress = 0;
  const seenReadFingerprints = new Set<string>();

  const resultsByCallId = new Map<
    string,
    { output: unknown; error: unknown; isError: boolean }
  >();

  for (const m of messages) {
    for (const p of (m.parts ?? []) as Record<string, unknown>[]) {
      if (p.type === "tool-result" && typeof p.toolCallId === "string") {
        const isErr =
          isToolCallError(p.output) || Boolean(p.error) || p.isError === true;
        resultsByCallId.set(p.toolCallId, {
          output: p.output,
          error: p.error,
          isError: isErr,
        });
      }
    }
  }

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of (m.parts ?? []) as Record<string, unknown>[]) {
      const type = typeof p.type === "string" ? p.type : "";

      if (
        type === "text" &&
        typeof p.text === "string" &&
        p.text.trim().length > 0
      ) {
        progress += 10 + Math.min(Math.floor(p.text.trim().length / 50), 20);
        continue;
      }

      let toolName = "";
      let input: unknown;
      let output: unknown;
      let error: unknown;
      let isError = false;
      let hasResult = false;

      if (type === "tool-call") {
        toolName = typeof p.toolName === "string" ? p.toolName : "";
        input = p.input ?? p.args;
        const callId = typeof p.toolCallId === "string" ? p.toolCallId : "";
        const standaloneRes = callId ? resultsByCallId.get(callId) : undefined;
        output = p.output ?? standaloneRes?.output;
        error = p.error ?? standaloneRes?.error;
        isError =
          standaloneRes?.isError ??
          (isToolCallError(output) || Boolean(error) || p.isError === true);
        hasResult =
          output !== undefined ||
          error !== undefined ||
          standaloneRes !== undefined ||
          p.state === "output-available";
      } else if (
        type.startsWith("tool-") &&
        type !== "tool-approval-request" &&
        type !== "tool-approval-response" &&
        type !== "tool-result"
      ) {
        toolName = typeof p.toolName === "string" ? p.toolName : type.slice(5);
        input = p.input ?? p.args;
        output = p.output;
        error = p.error;
        isError =
          isToolCallError(output) || Boolean(error) || p.isError === true;
        hasResult =
          output !== undefined ||
          error !== undefined ||
          p.state === "output-available";
      }

      if (toolName && hasResult) {
        if (isError) {
          // Errored tool calls do not count as productive progress
          continue;
        }

        const isMutating = isMutatingToolCall(toolName, input);
        if (isMutating) {
          seenReadFingerprints.clear();
          progress += 10;
        } else {
          const fp = canonicalToolFingerprint(toolName, input);
          if (!seenReadFingerprints.has(fp)) {
            seenReadFingerprints.add(fp);
            progress += 10;
          }
        }
      }
    }
  }

  return progress;
}

/**
 * Decide whether an automatic resume may happen, given a progress measure and
 * how many consecutive resumes have already added nothing. Also inspects recent
 * tool calls to break repetition loops and consecutive failure cycles.
 */
export function autoSendGate(
  previous: AutoSendGateState,
  progress: number,
  optionsOrMaxStalled: number | AutoSendGateOptions = MAX_STALLED_AUTO_SENDS,
): AutoSendDecision {
  const options: AutoSendGateOptions =
    typeof optionsOrMaxStalled === "number"
      ? { maxStalled: optionsOrMaxStalled }
      : optionsOrMaxStalled;

  const maxStalled = options.maxStalled ?? MAX_STALLED_AUTO_SENDS;
  const maxRepeats = options.maxToolRepeats ?? MAX_AUTO_SEND_TOOL_REPEATS;
  const maxConsecutiveErrors =
    options.maxConsecutiveErrors ?? MAX_CONSECUTIVE_AUTO_SEND_ERRORS;
  const maxTotalAutoSends =
    options.maxTotalAutoSends ?? MAX_TOTAL_AUTO_SENDS;
  const recentToolCalls = options.recentToolCalls ?? [];
  const currentTotal = previous.totalAutoSends ?? 0;

  // Guard 0: Maximum total automatic sends per task turn
  if (currentTotal >= maxTotalAutoSends) {
    return {
      allow: false,
      state: {
        lastProgress: previous.lastProgress,
        stalled: previous.stalled,
        totalAutoSends: currentTotal,
        lastToolFingerprint: previous.lastToolFingerprint,
      },
      stoppedLoop: true,
      reason: `task reached the maximum limit of ${maxTotalAutoSends} automatic sends. Press Continue to go on.`,
    };
  }

  // Guard 1: Tool repetition and repeated error loop detection
  if (recentToolCalls.length >= 2) {
    const windowSize = Math.max(maxRepeats * 2, 6);
    const window = recentToolCalls.slice(-windowSize);

    const counts = new Map<
      string,
      {
        count: number;
        errorCount: number;
        toolName: string;
        input: unknown;
        inputDesc: string;
      }
    >();

    for (const call of window) {
      const isMutating = isMutatingToolCall(call.toolName, call.input);
      if (isMutating && !call.isError) {
        // A successful mutation occurred: prior read tool repeat counts reset
        // because the workspace state changed and re-reading is productive.
        for (const entry of counts.values()) {
          if (!isMutatingToolCall(entry.toolName, entry.input)) {
            entry.count = 0;
          }
        }
      }

      const fp = canonicalToolFingerprint(call.toolName, call.input);
      const cur = counts.get(fp) ?? {
        count: 0,
        errorCount: 0,
        toolName: call.toolName,
        input: call.input,
        inputDesc: summarizeInput(call.toolName, call.input),
      };
      cur.count += 1;
      if (call.isError) {
        cur.errorCount += 1;
      }
      counts.set(fp, cur);
    }

    for (const [_, info] of counts.entries()) {
      // If the exact same tool call failed 2 or more times with identical args
      if (info.errorCount >= 2 && info.count >= 2) {
        return {
          allow: false,
          state: {
            lastProgress: previous.lastProgress,
            stalled: previous.stalled + 1,
            totalAutoSends: currentTotal,
            lastToolFingerprint: info.toolName,
          },
          stoppedLoop: true,
          reason: `tool "${info.toolName}" on ${info.inputDesc} failed repeatedly with identical arguments`,
        };
      }

      // If the exact same tool call repeated 3 or more times without intervening mutations
      if (info.count >= maxRepeats) {
        return {
          allow: false,
          state: {
            lastProgress: previous.lastProgress,
            stalled: previous.stalled + 1,
            totalAutoSends: currentTotal,
            lastToolFingerprint: info.toolName,
          },
          stoppedLoop: true,
          reason: `tool "${info.toolName}" on ${info.inputDesc} repeated ${info.count} times without making progress`,
        };
      }
    }

    // Guard 2: Consecutive errors across any tools
    let trailingErrors = 0;
    for (let i = recentToolCalls.length - 1; i >= 0; i--) {
      if (recentToolCalls[i].isError) {
        trailingErrors += 1;
      } else {
        break;
      }
    }
    if (trailingErrors >= maxConsecutiveErrors) {
      return {
        allow: false,
        state: {
          lastProgress: previous.lastProgress,
          stalled: previous.stalled + 1,
          totalAutoSends: currentTotal,
        },
        stoppedLoop: true,
        reason: `${trailingErrors} consecutive tool calls failed without making progress`,
      };
    }
  }

  // Guard 3: Stalled progress check
  if (progress > previous.lastProgress) {
    return {
      allow: true,
      state: {
        lastProgress: progress,
        stalled: 0,
        totalAutoSends: currentTotal + 1,
      },
      stoppedLoop: false,
    };
  }

  const stalled = previous.stalled + 1;
  if (stalled > maxStalled) {
    return {
      allow: false,
      state: {
        lastProgress: previous.lastProgress,
        stalled,
        totalAutoSends: currentTotal,
      },
      stoppedLoop: true,
      reason: `run made no progress after ${stalled} automatic sends`,
    };
  }

  return {
    allow: true,
    state: {
      lastProgress: previous.lastProgress,
      stalled,
      totalAutoSends: currentTotal + 1,
    },
    stoppedLoop: false,
  };
}

/**
 * Whether this ask is the same authorised send being asked about again.
 *
 * The SDK may call the predicate more than once inside one cycle, and counting
 * each ask would tighten the bound silently. The caller clears `pending` when a
 * round really begins, which makes one cycle equal one count.
 */
export function autoSendAskIsDuplicate(input: {
  /** An authorised automatic send that has not become a round yet. */
  pending: boolean;
  /** The progress value the last decision was made at. */
  decidedAt: number;
  /** Progress of the transcript being asked about. */
  progress: number;
}): boolean {
  return input.pending && input.progress === input.decidedAt;
}

