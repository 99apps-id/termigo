// Telegram long-poll loop, stall watchdog, and bot start/stop lifecycle.
//
// Extracted from bot.ts so the polling concerns are isolated and the polling
// layer only depends on the command router.

import { useTelegramStore } from "./store";
import { apiGet, TelegramApiError } from "./telegramApi";
import { handleUpdate, type Update } from "./telegramCommands";
import { runMirror } from "./telegramDispatch";
import {
  botIdFromToken,
  hasStoredUpdateOffset,
  loadUpdateOffset,
  saveUpdateOffset,
} from "./telegramUpdateOffset";
import { getTelegramToken } from "./keyring";
import {
  logRelayInfo,
  logRelayWarn,
  relayErrorLine,
  updateLine,
} from "./telegramLog";

export let loopController: AbortController | null = null;
export let mirrorController: AbortController | null = null;
/**
 * Signal the update handlers (and therefore the agent runs they dispatch) run
 * under. Kept separate from `loopController` on purpose: the stall watchdog
 * recycles `loopController` to recover `getUpdates`, and aborting the signal
 * the runs share would cancel every in-flight run the moment polling hiccups.
 * Only `stopTelegramBot` aborts this one.
 */
export let relayController: AbortController | null = null;

const OFFSET_STORAGE_KEY = "termigo-telegram-offset";

function readStoredOffset(): number {
  if (typeof localStorage === "undefined") return 0;
  try {
    const raw = localStorage.getItem(OFFSET_STORAGE_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function persistOffset(offset: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(OFFSET_STORAGE_KEY, String(offset));
  } catch {
    // A full or unavailable localStorage must not stop the poll loop.
  }
}

export let currentUpdateOffset = readStoredOffset();
/**
 * Bot id (the token prefix) that `currentUpdateOffset` belongs to. Keeps the
 * durable copy under the right key and stops a token change from carrying a
 * stale offset onto a different bot.
 */
let currentBotId: string | null = null;
export let lastPollProgressTime = Date.now();
export const POLLING_STALL_TIMEOUT_MS = 75_000;
export let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const cleanupStoppers = new Map<string, () => void>();

/**
 * When the loop is deliberately waiting, and the watchdog must stay out of the
 * way. Zero means "not waiting".
 *
 * This is the fix for a real failure. The poll loop backs off 60s after a 409,
 * but that backoff updated nothing the watchdog reads, and the last successful
 * poll was one 30s long-poll earlier - so `elapsed` was already ~30s when the
 * backoff began and crossed the 75s window before the backoff ended. The
 * watchdog therefore fired in the middle of EVERY conflict backoff, recycled
 * the poller, and its replacement re-acquired the bot immediately: the exact
 * churn the backoff exists to prevent, because the backoff's whole purpose is
 * to give the other client room. Seen in the field as
 *   409 -> stalled 89s -> recycle -> 409 -> stalled 90s -> recycle
 * repeating for as long as the competing client was around.
 *
 * Declared rather than inferred: the loop knows it is waiting on purpose, so
 * it says so instead of the watchdog trying to guess from a timer.
 */
let deliberateWaitUntil = 0;

/**
 * The loop currently polling, so the watchdog can wait for it to finish before
 * starting its replacement.
 *
 * Without this the recovery was the fault: the watchdog aborted the hanging
 * fetch and started a new poller in the same tick, so for as long as the old
 * request stayed alive Telegram saw TWO clients polling one bot token and
 * terminated one with 409 "Conflict: terminated by other getUpdates request".
 * Each recycle therefore caused the next stall, about 90-190s later, forever.
 * Observed on the field install as a repeating pattern of
 *   stalled 188s -> recycle ... 409 Conflict ... stalled 91s -> recycle
 * which delayed every inbound message by up to three minutes.
 */
let loopPromise: Promise<void> | null = null;

/**
 * How long to wait for the previous poller to exit before starting the
 * replacement anyway. Bounded, because the whole reason the watchdog exists is
 * that a hung fetch can outlive its abort signal. 10s is long past the point
 * where the aborted request has been torn down in the normal case, and short
 * enough to still recover.
 */
const STALL_RECYCLE_GRACE_MS = 10_000;

/**
 * Backoff after Telegram answers 409.
 *
 * Far longer than the generic 5s on purpose: a conflict means another client
 * holds the bot, and retrying quickly is exactly what keeps two pollers
 * terminating each other. Standing down gives the other one room, and a real
 * competing client is a configuration problem the operator has to fix - not
 * something to hammer at five-second intervals.
 *
 * This is the base of an exponential schedule, not a flat delay: a competitor
 * that stays up for hours (a forgotten VPS instance, another app on the same
 * token) used to be re-probed every 60s forever - 261 conflict cycles in one
 * night's log. Each consecutive conflict doubles the wait up to
 * `TELEGRAM_CONFLICT_BACKOFF_MAX_MS`; the first success resets the streak.
 */
export const TELEGRAM_CONFLICT_BACKOFF_MS = 60_000;

/** Ceiling for the exponential conflict backoff (15 minutes). */
export const TELEGRAM_CONFLICT_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Consecutive 409s seen by the current loop. Reset on any successful poll and
 * on start/stop, so the schedule never carries over into a healthy session.
 */
let conflictStreak = 0;

/**
 * Exponential conflict backoff: 60s, 120s, 240s, ... capped at 15 min.
 *
 * `streak` is 1-based (the first conflict waits the base), pure so the
 * schedule is asserted rather than observed over hours.
 */
export function conflictBackoffMs(streak: number): number {
  const n = Math.max(1, Math.floor(streak));
  return Math.min(
    TELEGRAM_CONFLICT_BACKOFF_MS * 2 ** (n - 1),
    TELEGRAM_CONFLICT_BACKOFF_MAX_MS,
  );
}

/**
 * Base wait after an ordinary `getUpdates` failure, and the ceiling the wait
 * grows to while failures repeat.
 *
 * A box that loses its network used to log `getUpdates failed ... retrying in
 * 5s` every five seconds for hours: the wait never grew, so an offline machine
 * hammered DNS and drowned the file log. The wait doubles per consecutive
 * failure and caps at a minute; one success resets it to the base.
 */
export const TELEGRAM_GENERIC_BACKOFF_BASE_MS = 5_000;
export const TELEGRAM_GENERIC_BACKOFF_CAP_MS = 60_000;

export function setCurrentUpdateOffset(offset: number): void {
  currentUpdateOffset = offset;
  persistOffset(offset);
  if (currentBotId) {
    saveUpdateOffset(currentBotId, offset);
  }
}

export function setLastPollProgressTime(t: number): void {
  lastPollProgressTime = t;
}

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Whether the loop looks hung rather than deliberately waiting.
 *
 * Pure, so the policy is asserted rather than buried in the interval callback -
 * the same reason `pollBackoffMs` is pure. No clock, no network, no chat.
 *
 * The order matters: a declared wait wins outright. Measuring `lastProgressAt`
 * first is what produced the bug, because a backoff is by definition a period
 * with no progress to measure.
 */
export function isPollingStalled(input: {
  now: number;
  lastProgressAt: number;
  deliberateWaitUntil: number;
}): boolean {
  if (input.now < input.deliberateWaitUntil) return false;
  return input.now - input.lastProgressAt > POLLING_STALL_TIMEOUT_MS;
}

export function checkPollingStall(): void {
  if (!useTelegramStore.getState().enabled || !loopController) return;
  const now = Date.now();
  if (
    !isPollingStalled({
      now,
      lastProgressAt: lastPollProgressTime,
      deliberateWaitUntil,
    })
  ) {
    return;
  }
  // In the file log as well as the console: on a headless install nobody is
  // watching the console, and a recycled poller is otherwise invisible.
  const elapsed = now - lastPollProgressTime;
  const seconds = Math.round(elapsed / 1000);
  logRelayWarn(
    `polling stalled: no getUpdates progress for ${seconds}s, recycling poller`,
  );
  console.warn(
    `[Telegram] Polling stall detected: no getUpdates progress for ${seconds}s. Reconnecting poller...`,
  );
  const oldCtrl = loopController;
  const oldLoop = loopPromise;
  const next = new AbortController();
  loopController = next;
  lastPollProgressTime = now;
  // A recycle is not a wait, and leaving a stale deadline behind would suppress
  // the next genuine stall for as long as it lasted.
  deliberateWaitUntil = 0;
  // Abort so the hanging fetch terminates cleanly.
  oldCtrl.abort(new Error("Polling stall watchdog timeout"));
  // Start the replacement only after the old loop has exited (or the grace
  // period lapses), so the two never poll at the same time. Racing the wait
  // against a timer keeps recovery possible when the abort does not land.
  void Promise.race([
    oldLoop ?? Promise.resolve(),
    sleep(new AbortController().signal, STALL_RECYCLE_GRACE_MS),
  ]).then(() => {
    if (loopController !== next || next.signal.aborted) return;
    launchLoop(next);
  });
}

/** Run `runLoop`, recording the promise so the watchdog can await it. */
function launchLoop(controller: AbortController): void {
  const promise = runLoop(controller.signal);
  loopPromise = promise;
  void promise.finally(() => {
    if (loopPromise === promise) loopPromise = null;
  });
}

/**
 * How long to wait before the next `getUpdates` after a failure.
 *
 * Exported and pure so the policy is asserted rather than buried in the catch:
 * a 429 carries its own retry hint, a 409 means another client holds the bot
 * and must not be retried quickly (and grows exponentially with the conflict
 * streak, so an hours-long competitor is probed at most every 15 min instead
 * of every minute), and anything else doubles with its OWN streak from a 5s
 * base to a 60s cap — an offline machine must not hammer DNS every five
 * seconds for hours. Two streaks, because a network flap must not inflate the
 * conflict schedule and a competitor must not look like an outage.
 */
export function pollBackoffMs(
  error: unknown,
  conflictStreak = 1,
  genericStreak = 1,
): number {
  if (error instanceof TelegramApiError) {
    if (error.status === 429) {
      return Math.max(1000, (error.retryAfter ?? 5) * 1000);
    }
    if (error.status === 409) return conflictBackoffMs(conflictStreak);
  }
  const n = Number.isFinite(genericStreak)
    ? Math.max(1, Math.floor(genericStreak))
    : 1;
  return Math.min(
    TELEGRAM_GENERIC_BACKOFF_BASE_MS * 2 ** (n - 1),
    TELEGRAM_GENERIC_BACKOFF_CAP_MS,
  );
}

/**
 * Whether a `getUpdates` failure is the client-side deadline firing rather than
 * a network/API fault.
 *
 * The request timeout aborts the fetch, and how that surfaces is
 * implementation-defined: modern fetch rejects with the abort REASON
 * ("Timeout after 50000ms"), but some webview builds reject with the generic
 * AbortError ("The user aborted a request."). Field logs showed the latter
 * landing in the generic-failure branch: the bot was marked offline, the
 * failure streak escalated the backoff, and the log filled with
 * "retrying in 5s" — all because one long-poll was slow. Callers only consult
 * this AFTER ruling out an abort of the loop's own signal, so an AbortError
 * reaching here can only be the request deadline.
 */
export function isPollTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.message.includes("Timeout after")) return true;
  if (e.name === "TimeoutError") return true;
  if (e.name === "AbortError") return true;
  return /aborted a request/i.test(e.message);
}

async function runLoop(signal: AbortSignal): Promise<void> {
  // Ordinary failures back off harder while they repeat (see pollBackoffMs);
  // any success resets the streak. Timeouts below keep their own 1s pause and
  // leave the streak alone.
  let consecutiveFailures = 0;
  while (!signal.aborted && useTelegramStore.getState().enabled) {
    try {
      const data = (await apiGet(
        `getUpdates?offset=${currentUpdateOffset}&timeout=30`,
        signal,
        45_000,
      )) as { ok: boolean; result: Update[] };
      lastPollProgressTime = Date.now();
      // A success ends the conflict streak, so the next 409 (if ever) starts
      // back at the base delay instead of resuming a doubled schedule.
      conflictStreak = 0;
      useTelegramStore.getState().setOnline(true);
      useTelegramStore.getState().setLastError(null);
      consecutiveFailures = 0;
      // Handlers run under the relay signal, not the poll signal, so a watchdog
      // recycle of the poller never cancels an in-flight agent run.
      const relaySignal = relayController?.signal ?? signal;
      for (const u of data.result ?? []) {
        if (signal.aborted || relaySignal.aborted) break;
        // One line per update, before it is handled: an update that arrives and
        // then fails is the case that used to leave no trace at all.
        logRelayInfo(updateLine(u));
        // One bad update (a malformed payload, a 400 from answerCallback on an
        // expired query) must not drop the rest of the batch. Catch per update
        // and still advance past it, or Telegram redelivers the poison update
        // on every poll forever.
        try {
          await handleUpdate(u, relaySignal);
        } catch (e) {
          logRelayWarn(relayErrorLine(`update ${u.update_id}`, e));
          console.warn(
            `[Telegram] update ${u.update_id} handler failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        setCurrentUpdateOffset(Math.max(currentUpdateOffset, u.update_id + 1));
      }
    } catch (e) {
      if (signal.aborted) break;
      // A client-side deadline (slow long-poll) is not an outage: stay online,
      // pause briefly so Telegram's server can close the previous aborted
      // connection, and poll again. Classified via isPollTimeoutError because
      // some webview builds surface the deadline as a generic AbortError
      // ("The user aborted a request.") instead of the abort reason.
      if (isPollTimeoutError(e)) {
        lastPollProgressTime = Date.now();
        useTelegramStore.getState().setOnline(true);
        await sleep(signal, 1000);
        continue;
      }
      useTelegramStore.getState().setOnline(false);
      const errMsg = e instanceof Error ? e.message : String(e);
      useTelegramStore.getState().setLastError(errMsg);
      if (e instanceof TelegramApiError && e.status === 409) conflictStreak += 1;
      consecutiveFailures += 1;
      const backoffMs = pollBackoffMs(e, conflictStreak, consecutiveFailures);
      // The store keeps lastError for the UI, but the UI is a webview on a
      // server nobody is looking at. A poll that keeps failing has to reach the
      // file, or "the bot went quiet" has no cause attached to it.
      logRelayWarn(
        `${relayErrorLine("getUpdates", e)} - retrying in ${Math.round(backoffMs / 1000)}s`,
      );
      if (e instanceof TelegramApiError && e.status === 409) {
        // Named explicitly because it is actionable and otherwise looks like a
        // network fault: a 409 means a SECOND client is polling this bot token.
        // The streak and the next wait are in the line so an operator reading
        // the log can tell "one hiccup" from "six hours of a competitor".
        logRelayWarn(
          `409 Conflict: another client holds this bot token - check for a second Termigo instance, or another app configured with the same token (conflict #${conflictStreak}, next retry in ${Math.round(backoffMs / 1000)}s)`,
        );
      }
      // Declare the wait BEFORE sleeping, so the watchdog never sees a stall
      // during it. See `deliberateWaitUntil` for the failure this fixes.
      deliberateWaitUntil = Date.now() + backoffMs;
      await sleep(signal, backoffMs);
      // The wait is over and the loop is attempting again, so the stall clock
      // restarts from here rather than from the last success. Without this the
      // window between the wait ending and the next failure would read as
      // elapsed time with nothing happening.
      deliberateWaitUntil = 0;
      lastPollProgressTime = Date.now();
    }
  }
  if (loopController?.signal === signal) {
    useTelegramStore.getState().setOnline(false);
    logRelayInfo("polling stopped");
  }
}

/** Start the long-polling loop (idempotent). */
export async function startTelegramBot(): Promise<void> {
  if (loopController) return;
  const controller = new AbortController();
  loopController = controller;
  const mirror = new AbortController();
  mirrorController = mirror;
  relayController = new AbortController();
  lastPollProgressTime = Date.now();
  deliberateWaitUntil = 0;
  conflictStreak = 0;
  // Restore the offset Telegram had already confirmed before the first poll —
  // this MUST happen before launchLoop: without it the loop starts at 0 and
  // Telegram replays the last unconfirmed batch, running its commands (an old
  // /run, /approve, /mode all) a second time. The token read and offset load
  // are fast; the slow AI-store import stays after launchLoop below.
  currentBotId = botIdFromToken(await getTelegramToken());
  // stopTelegramBot() may have run while we awaited the token. Without this
  // guard the watchdog is installed just after stop cleared it, so it ticks on
  // for a bot that is already stopped and nothing ever clears it again.
  if (loopController !== controller || controller.signal.aborted) return;
  currentUpdateOffset = loadUpdateOffset(currentBotId);
  if (currentBotId && !hasStoredUpdateOffset(currentBotId)) {
    // Fresh bot (first run or token rotation): starting at 0 would replay the
    // whole unconfirmed backlog and re-run its commands. Seeding from the old
    // bot's offset is worse (update ids are per-bot; a stale high offset
    // silently SKIPS the new bot's early updates). Instead take one immediate
    // (timeout=0) poll and start past whatever is already waiting: the backlog
    // is explicitly dropped, nothing replays and nothing is skipped.
    // Best-effort - on any failure the loop starts at 0, today's behavior.
    try {
      const backlog = (await apiGet(
        "getUpdates?timeout=0",
        controller.signal,
        15_000,
      )) as { ok: boolean; result: Update[] };
      if (loopController !== controller || controller.signal.aborted) return;
      let maxId = -1;
      for (const u of backlog.result ?? []) {
        if (typeof u.update_id === "number" && u.update_id > maxId) {
          maxId = u.update_id;
        }
      }
      if (maxId >= 0) {
        const dropped = backlog.result?.length ?? 0;
        setCurrentUpdateOffset(maxId + 1);
        logRelayInfo(
          `fresh bot: acknowledged-and-dropped ${dropped} backlog update(s), starting at offset ${currentUpdateOffset}`,
        );
      }
    } catch {
      // Fall through with offset 0; the long-poll loop reports the cause.
    }
  }
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(checkPollingStall, 15_000);
  // Start polling BEFORE any awaiting setup. The bot used to report itself
  // online and only then await the stale-approval cleanup, so a slow or hung
  // AI-store import left it claiming to be online with nothing polling - which
  // looks exactly like "Telegram tidak bisa dipakai".
  launchLoop(controller);
  void runMirror(mirror.signal);
  logRelayInfo("relay started");
  try {
    const { cleanupStaleApprovals, startPeriodicStaleApprovalCleanup } =
      await import("../ai/store/approvalQueueStore");
    const cleaned = await cleanupStaleApprovals();
    if (cleaned > 0) {
      // Stale approvals are the residue of runs killed mid-approval; counting
      // them is how a recurrence of that bug becomes visible.
      logRelayInfo(`cleaned ${cleaned} stale approval(s) on start`);
      console.warn(`[ai] cleaned ${cleaned} stale approvals on startup`);
    }
    const stopPeriodicCleanup = startPeriodicStaleApprovalCleanup();
    if (typeof stopPeriodicCleanup === "function") {
      // We may have been stopped while importing the store. Registering it now
      // would leak an interval into a map stopTelegramBot() already cleared, so
      // stop it immediately instead.
      if (loopController !== controller) {
        stopPeriodicCleanup();
        return;
      }
      cleanupStoppers.set("staleApproval", stopPeriodicCleanup);
    }
  } catch {
    // best-effort cleanup; if the store isn't ready yet, the next cycle will catch it.
  }
}

/** Stop the long-polling loop. */
export function stopTelegramBot(): void {
  // Only log when something was actually running: this is called on every
  // render of the effect that owns the bot, including on a mount where the
  // relay was never started, and a "relay stopped" line there would be noise.
  const wasRunning = loopController !== null;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  for (const stop of cleanupStoppers.values()) {
    try {
      stop();
    } catch {
      // best-effort teardown
    }
  }
  cleanupStoppers.clear();
  loopController?.abort();
  loopController = null;
  mirrorController?.abort();
  mirrorController = null;
  relayController?.abort();
  relayController = null;
  deliberateWaitUntil = 0;
  conflictStreak = 0;
  useTelegramStore.getState().setOnline(false);
  if (wasRunning) logRelayInfo("relay stopped");
}
