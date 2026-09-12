// Telegram long-poll loop, stall watchdog, and bot start/stop lifecycle.
//
// Extracted from bot.ts so the polling concerns are isolated and the polling
// layer only depends on the command router.

import { apiGet, TelegramApiError } from "./telegramApi";
import { handleUpdate, type Update } from "./telegramCommands";
import { runMirror } from "./telegramDispatch";
import {
  logRelayInfo,
  logRelayWarn,
  relayErrorLine,
  updateLine,
} from "./telegramLog";
import { useTelegramStore } from "./store";

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

export let currentUpdateOffset = 0;
export let lastPollProgressTime = Date.now();
export const POLLING_STALL_TIMEOUT_MS = 75_000;
export let watchdogTimer: ReturnType<typeof setInterval> | null = null;

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
 */
export const TELEGRAM_CONFLICT_BACKOFF_MS = 60_000;

export function setCurrentUpdateOffset(offset: number): void {
  currentUpdateOffset = offset;
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

export function checkPollingStall(): void {
  if (!useTelegramStore.getState().enabled || !loopController) return;
  const elapsed = Date.now() - lastPollProgressTime;
  if (elapsed > POLLING_STALL_TIMEOUT_MS) {
    // In the file log as well as the console: on a headless install nobody is
    // watching the console, and a recycled poller is otherwise invisible.
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
    lastPollProgressTime = Date.now();
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
 * and must not be retried quickly, and anything else gets a short retry.
 */
export function pollBackoffMs(error: unknown): number {
  if (error instanceof TelegramApiError) {
    if (error.status === 429) {
      return Math.max(1000, (error.retryAfter ?? 5) * 1000);
    }
    if (error.status === 409) return TELEGRAM_CONFLICT_BACKOFF_MS;
  }
  return 5000;
}

async function runLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted && useTelegramStore.getState().enabled) {
    try {
      const data = (await apiGet(
        `getUpdates?offset=${currentUpdateOffset}&timeout=30`,
        signal,
        45_000,
      )) as { ok: boolean; result: Update[] };
      lastPollProgressTime = Date.now();
      useTelegramStore.getState().setOnline(true);
      useTelegramStore.getState().setLastError(null);
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
        currentUpdateOffset = Math.max(currentUpdateOffset, u.update_id + 1);
      }
    } catch (e) {
      if (signal.aborted) break;
      useTelegramStore.getState().setOnline(false);
      const errMsg = e instanceof Error ? e.message : String(e);
      useTelegramStore.getState().setLastError(errMsg);
      const backoffMs = pollBackoffMs(e);
      // The store keeps lastError for the UI, but the UI is a webview on a
      // server nobody is looking at. A poll that keeps failing has to reach the
      // file, or "the bot went quiet" has no cause attached to it.
      logRelayWarn(
        `${relayErrorLine("getUpdates", e)} - retrying in ${Math.round(backoffMs / 1000)}s`,
      );
      if (e instanceof TelegramApiError && e.status === 409) {
        // Named explicitly because it is actionable and otherwise looks like a
        // network fault: a 409 means a SECOND client is polling this bot token.
        logRelayWarn(
          "409 Conflict: another client holds this bot token - check for a second Termigo instance, or another app configured with the same token",
        );
      }
      await sleep(signal, backoffMs);
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
    const { cleanupStaleApprovals } = await import(
      "../ai/store/approvalQueueStore"
    );
    const cleaned = await cleanupStaleApprovals();
    if (cleaned > 0) {
      // Stale approvals are the residue of runs killed mid-approval; counting
      // them is how a recurrence of that bug becomes visible.
      logRelayInfo(`cleaned ${cleaned} stale approval(s) on start`);
      console.warn(`[ai] cleaned ${cleaned} stale approvals on startup`);
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
  loopController?.abort();
  loopController = null;
  mirrorController?.abort();
  mirrorController = null;
  relayController?.abort();
  relayController = null;
  useTelegramStore.getState().setOnline(false);
  if (wasRunning) logRelayInfo("relay stopped");
}
