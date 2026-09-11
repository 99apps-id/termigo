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
      for (const u of data.result ?? []) {
        currentUpdateOffset = Math.max(currentUpdateOffset, u.update_id + 1);
        await handleUpdate(u, signal);
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
  lastPollProgressTime = Date.now();
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(checkPollingStall, 15_000);
  useTelegramStore.getState().setOnline(true);
  useTelegramStore.getState().setLastError(null);
  try {
    const { cleanupStaleApprovals } = await import("../ai/store/approvalQueueStore");
    const cleaned = await cleanupStaleApprovals();
    if (cleaned > 0) {
      console.warn(`[ai] cleaned ${cleaned} stale approvals on startup`);
    }
  } catch {
    // best-effort cleanup; if the store isn't ready yet, the next cycle will catch it.
  }
  void runLoop(controller.signal);
  void runMirror(mirror.signal);
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
  useTelegramStore.getState().setOnline(false);
}
