// Long-polling loop, watchdog, mirror, and update handling for the Telegram bot.

import { apiGet, sleep, TelegramApiError } from "./api";
import { useTelegramStore } from "./store";
import { handleUpdate } from "./commands";
import { runMirror } from "./bot";

export type Update = {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    message_thread_id?: number | null;
  };
  callback_query?: {
    id: string;
    from?: { id: number };
    message?: {
      chat: { id: number };
      message_id?: number;
      message_thread_id?: number | null;
    };
    data?: string;
  };
};

export let currentUpdateOffset = 0;
export let lastPollProgressTime = Date.now();
export const POLLING_STALL_TIMEOUT_MS = 75_000;
export let watchdogTimer: ReturnType<typeof setInterval> | null = null;
export let loopController: AbortController | null = null;
export let mirrorController: AbortController | null = null;

export function checkPollingStall(): void {
  if (!useTelegramStore.getState().enabled || !loopController) return;
  const elapsed = Date.now() - lastPollProgressTime;
  if (elapsed > POLLING_STALL_TIMEOUT_MS) {
    console.warn(
      `[Telegram] Polling stall detected: no getUpdates progress for ${Math.round(
        elapsed / 1000,
      )}s. Reconnecting poller...`,
    );
    const oldCtrl = loopController;
    loopController = new AbortController();
    lastPollProgressTime = Date.now();
    oldCtrl.abort(new Error("Polling stall watchdog timeout"));
    void runLoop(loopController.signal);
  }
}

export async function runLoop(signal: AbortSignal): Promise<void> {
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

export function startTelegramBot(): void {
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
  void runLoop(controller.signal);
  void runMirror(mirror.signal);
}

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
