// Telegram long-poll loop, stall watchdog, and bot start/stop lifecycle.
//
// Extracted from bot.ts so the polling concerns are isolated and the polling
// layer only depends on the command router.

import { apiGet, TelegramApiError } from "./telegramApi";
import { handleUpdate, type Update } from "./telegramCommands";
import { runMirror } from "./telegramDispatch";
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
    console.warn(
      `[Telegram] Polling stall detected: no getUpdates progress for ${Math.round(
        elapsed / 1000,
      )}s. Reconnecting poller...`,
    );
    // Recycle controller so the hanging fetch terminates cleanly
    const oldCtrl = loopController;
    loopController = new AbortController();
    lastPollProgressTime = Date.now();
    oldCtrl.abort(new Error("Polling stall watchdog timeout"));
    void runLoop(loopController.signal);
  }
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
        // One bad update (a malformed payload, a 400 from answerCallback on an
        // expired query) must not drop the rest of the batch. Catch per update
        // and still advance past it, or Telegram redelivers the poison update
        // on every poll forever.
        try {
          await handleUpdate(u, relaySignal);
        } catch (e) {
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
      let backoffMs = 5000;
      if (e instanceof TelegramApiError && e.status === 429) {
        backoffMs = Math.max(1000, (e.retryAfter ?? 5) * 1000);
      }
      await sleep(signal, backoffMs);
    }
  }
  if (loopController?.signal === signal) {
    useTelegramStore.getState().setOnline(false);
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
  void runLoop(controller.signal);
  void runMirror(mirror.signal);
  try {
    const { cleanupStaleApprovals } = await import(
      "../ai/store/approvalQueueStore"
    );
    const cleaned = await cleanupStaleApprovals();
    if (cleaned > 0) {
      console.warn(`[ai] cleaned ${cleaned} stale approvals on startup`);
    }
  } catch {
    // best-effort cleanup; if the store isn't ready yet, the next cycle will catch it.
  }
}

/** Stop the long-polling loop. */
export function stopTelegramBot(): void {
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
}
