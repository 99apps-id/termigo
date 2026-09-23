/**
 * What a stream chunk means for the run's silence watchdog.
 *
 * The watchdog exists to catch a provider that goes quiet: the run stays
 * "streaming" forever, the UI shows a spinner, and messages typed meanwhile are
 * queued behind a run that will never finish. Observed in the field as ~20
 * minutes of `sdk=streaming app=streaming` with no further log line.
 *
 * It failed because it was cleared on the FIRST chunk of any kind and never
 * re-armed, so it protected only the opening moment of a run. A reasoning model
 * made that worse: a `reasoning-delta` is a chunk, so it cleared the watchdog
 * before the model had answered anything - and when the provider then stalled,
 * nothing was watching.
 *
 * The fix is to measure silence FROM NOW rather than time-to-first-response, and
 * to be explicit about which chunks legitimately mean "nobody is expected to be
 * sending": while a tool executes, a provider is silent by design and can be so
 * for minutes. Hence a three-way decision instead of a boolean.
 *
 * Pure so the policy is asserted by a test: only a real stalled provider can
 * exercise it otherwise.
 */
export type WatchdogDirective =
  /** The model is producing. Restart the silence clock. */
  | "rearm"
  /**
   * A tool is about to run. Stop watching: tool execution sends no chunks by
   * design, and a long one is normal (a build, a scan). `onStepFinish` re-arms
   * once the tool is done.
   */
  | "disarm"
  /** No opinion either way: leave the watchdog exactly as it is. */
  | "ignore";

/**
 * The chunk types that mean the model itself is still talking.
 *
 * `reasoning-delta` is included deliberately. It is easy to dismiss thinking as
 * "not an answer", but it IS the provider sending data - and treating it as
 * silence would abort a model that thinks for a while before answering, which is
 * a supported style rather than a fault.
 */
const MODEL_PRODUCING = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "source",
]);

/** The chunk that hands control to a tool, which then runs without sending. */
const HANDING_OFF = new Set(["tool-call"]);

/** The tool finished and the model is being asked again. */
const MODEL_AGAIN = new Set(["tool-result"]);

export function watchdogDirective(chunkType: string): WatchdogDirective {
  if (MODEL_PRODUCING.has(chunkType)) return "rearm";
  if (HANDING_OFF.has(chunkType)) return "disarm";
  if (MODEL_AGAIN.has(chunkType)) return "rearm";
  return "ignore";
}

/**
 * When the run last did anything at all.
 *
 * Silence on the parent's stream is NOT the same as a stalled run, which is what
 * the watchdog originally assumed and what made it abort live work: a tool that
 * runs for minutes - a subagent fan-out, a build, a scan - produces no parent
 * chunks while it works, and a subagent's own model calls happen in a separate
 * `generateText` that the parent's stream never sees. Observed in the field as
 * the watchdog aborting a run at 90s of "no stream progress" while subagent
 * provider responses were arriving up to a second before the abort.
 *
 * So the clock that matters counts ANY progress: a chunk, a tool result, or a
 * step reported by something the tool is driving. `tool-call` disarm covers the
 * well-behaved case, but it is timer choreography - any path that re-arms
 * defeats it, and one did. A shared clock cannot be defeated that way: the
 * watchdog re-checks it before deciding anything.
 *
 * Module-level state rather than a parameter, because the reporters live in
 * different layers (the agent loop, the tool layer) and threading a clock
 * through both would be plumbing for its own sake. Reset per run so a previous
 * run's activity cannot excuse a stalled one.
 */
let lastActivityAt: number | null = null;

/** Record that the run is doing something. */
export function markRunActivity(now: number = Date.now()): void {
  lastActivityAt = now;
}

/** Milliseconds since the run last did anything; Infinity before an arm. */
export function msSinceActivity(now: number = Date.now()): number {
  // `null`, not 0: a timestamp of 0 is a legitimate clock reading (a test clock
  // starts there), and treating it as "nothing happened" made the sentinel
  // collide with real data.
  if (lastActivityAt === null) return Number.POSITIVE_INFINITY;
  return now - lastActivityAt;
}

/** Forget previous activity, so a fresh run starts with a clean clock. */
export function resetRunActivity(): void {
  lastActivityAt = null;
}

/**
 * Whether silence has lasted long enough to call the run wedged.
 *
 * Takes the clock as an argument so the decision is testable without waiting:
 * the policy is "90s since ANY activity", not "90s since a chunk".
 */
export function silenceIsFatal(
  now: number,
  stallTimeoutMs: number,
  sinceActivityMs: number = msSinceActivity(now),
): boolean {
  return sinceActivityMs >= stallTimeoutMs;
}

/**
 * How long the watchdog should wait before deciding again.
 *
 * `0` means the silence already qualifies and the run should be aborted; any
 * other value is the remaining budget. This is what turns the watchdog from a
 * one-shot timer into a decision: the timer fires, the clock is consulted, and
 * a run that made progress in the meantime is simply given the rest of its
 * budget. A timer that aborts on its own (the previous design) is defeated by
 * any path that arms it without a matching disarm, and one was: on an approval
 * resume the `tool-call` chunk that disarms it arrived in the PREVIOUS run.
 */
export function remainingSilenceMs(
  now: number,
  stallTimeoutMs: number,
  sinceActivityMs: number = msSinceActivity(now),
): number {
  if (sinceActivityMs >= stallTimeoutMs) return 0;
  return stallTimeoutMs - sinceActivityMs;
}

/** Silence budget while waiting on the model, with no tool in flight. */
export const STALL_TIMEOUT_MS = 90_000;

/**
 * Silence budget for an approval resume, whose step 0 executes the approved tool
 * before the model is called at all.
 */
export const STALL_TIMEOUT_ON_RESUME_MS = 180_000;

/** Room over a tool's OWN timeout, so the tool reports its timeout first. */
export const TOOL_TIMEOUT_SLACK_MS = 30_000;

/** Ceiling, so one absurd `timeout_secs` cannot disable the watchdog. */
export const STALL_BUDGET_CAP_MS = 30 * 60_000;

/**
 * The `timeout_secs` of the tool call the run is resuming, if it declared one.
 *
 * A resume's step 0 runs the approved tool with no stream chunks and no step
 * boundary, so the tool's own timeout is the only honest statement about how
 * long the silence is expected to last. In the field the watchdog was armed for
 * 180s while the model had asked for `timeout_secs: 300`: the abort fired first
 * every time, the tool was killed mid-compile, and the tool's own "timed out"
 * result - the thing the model can act on - could never be produced. Re-running
 * the same command from scratch every 3 minutes looked exactly like an agent
 * that had stopped moving.
 */
export function pendingApprovalToolTimeoutMs(
  messages: readonly unknown[],
): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = (messages[i] as { parts?: unknown })?.parts;
    if (!Array.isArray(parts)) continue;
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j] as { state?: string; input?: unknown };
      if (part?.state !== "approval-responded") continue;
      let input = part.input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          continue;
        }
      }
      if (!input || typeof input !== "object") continue;
      const raw = input as Record<string, unknown>;
      const secs = raw.timeout_secs ?? raw.timeoutSecs ?? raw.timeout;
      if (typeof secs !== "number" || !Number.isFinite(secs) || secs <= 0) {
        return null;
      }
      return secs * 1000;
    }
  }
  return null;
}

/**
 * The silence budget for a run, never shorter than the tool it is guarding.
 *
 * Without a declared timeout the resume keeps its fixed budget: the tool layer's
 * own heartbeat (see `startActivityHeartbeat`) is what keeps a long tool from
 * looking like a stall in that case.
 */
export function stallBudgetMs(
  messages: readonly unknown[],
  resumingApproval: boolean,
): number {
  if (!resumingApproval) return STALL_TIMEOUT_MS;
  const toolMs = pendingApprovalToolTimeoutMs(messages);
  if (toolMs === null) return STALL_TIMEOUT_ON_RESUME_MS;
  return Math.min(
    Math.max(STALL_TIMEOUT_ON_RESUME_MS, toolMs + TOOL_TIMEOUT_SLACK_MS),
    STALL_BUDGET_CAP_MS,
  );
}

/**
 * Keep the activity clock fresh while something long is running.
 *
 * The watchdog sees chunks and step boundaries; a tool that runs for minutes
 * produces neither. Wrapping EVERY tool with this is what makes the clock mean
 * "the run is doing something" rather than "the model is talking" - the same
 * mistake in a different place, since a subagent's model calls never reach the
 * parent's stream either.
 *
 * Bounded on purpose: a heartbeat that never stops would excuse a genuinely hung
 * tool forever, so after `maxMs` it stops marking and the watchdog can fire.
 * That keeps both properties - a long but live tool is not killed, and a dead
 * one still is.
 *
 * Returns the stop function; calling it twice is harmless.
 */
export function startActivityHeartbeat(options?: {
  intervalMs?: number;
  maxMs?: number;
  now?: () => number;
  mark?: (now: number) => void;
}): () => void {
  const intervalMs = options?.intervalMs ?? 10_000;
  const maxMs = options?.maxMs ?? 20 * 60_000;
  const now = options?.now ?? (() => Date.now());
  const mark = options?.mark ?? ((at: number) => markRunActivity(at));
  const startedAt = now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  mark(startedAt);
  timer = setInterval(() => {
    const at = now();
    if (at - startedAt >= maxMs) {
      stop();
      return;
    }
    mark(at);
  }, intervalMs);
  // A heartbeat must never be the reason the process cannot exit.
  (timer as unknown as { unref?: () => void })?.unref?.();
  return stop;
}

/** Budget for the model to answer after a tool result is fed back. */
export const TOOL_RESULT_DELIVERY_MS = 60_000;

/**
 * What the tool-result delivery guard should do when its timer fires.
 *
 * Pure so the policy is asserted by a test: only a stalled provider in the
 * field can exercise it otherwise.
 *
 * After a tool result is fed back, the model owes the next output - but "no
 * chunk for 60s" is not the same as "nothing is happening". A sibling tool
 * from the same step can still be executing (its heartbeat keeps the activity
 * clock fresh), or a chunk can land just before the timer fires. Aborting
 * unconditionally killed runs that were making progress: observed in the field
 * as `no model output after tool-result ... aborting` on a run whose tools
 * were still heartbeating. So a stale clock is the only firing condition;
 * anything fresher just moves the check to the end of the budget.
 */
export function deliveryCheckDecision(
  now: number,
  options?: {
    deliveryBudgetMs?: number;
    sinceActivityMs?: number;
  },
): { abort: boolean; recheckInMs: number } {
  const budget = options?.deliveryBudgetMs ?? TOOL_RESULT_DELIVERY_MS;
  const sinceActivity = options?.sinceActivityMs ?? msSinceActivity(now);
  if (sinceActivity < budget) {
    return { abort: false, recheckInMs: budget - sinceActivity };
  }
  return { abort: true, recheckInMs: 0 };
}

