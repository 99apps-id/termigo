// Background scheduler for session tasks.
//
// `/schedule` stores tasks in the session directive store. This module ticks
// on a timer and, for any task whose `nextDueAt` has passed, submits the task's
// prompt through the chat runtime (so the agent runs and posts to chat), then
// reschedules. It keeps the scheduling math (parse / next-fire / due) pure and
// testable, and only the tick loop touches the chat store and `sendMessage`.
//
// The store + chat runtime are imported lazily inside `tick` so this module can
// be imported from the main window's startup path without eagerly pulling the
// AI runtime stack (enforced by `app/eager-budget.test.ts`).

import type { SessionSchedule } from "../store/sessionDirectiveStore";

const TICK_MS = 15_000;

export type ScheduleTiming = { intervalMs?: number; dailyAt?: string };

/** Parse the human `when` of a `/schedule` into a repeat rule.
 *  Supported: "every <N>s|m|h", "daily at HH:MM" / "daily HH:MM". Unknown
 *  strings yield no auto timing (the task is still recorded, just not run). */
export function parseScheduleWhen(when: string): ScheduleTiming {
  const w = when.trim().toLowerCase();
  const interval = w.match(/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (interval) {
    const n = Number(interval[1]);
    const unit = interval[2][0];
    const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
    return { intervalMs: ms };
  }
  const daily = w.match(/^daily(?:\s+at)?\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const hh = daily[1].padStart(2, "0");
    const mm = daily[2];
    return { dailyAt: `${hh}:${mm}` };
  }
  return {};
}

/** The next fire time, or null when the task has no repeat rule. */
export function computeNextDueAt(now: number, timing: ScheduleTiming): number | null {
  if (timing.intervalMs) return now + timing.intervalMs;
  if (timing.dailyAt) {
    const [hh, mm] = timing.dailyAt.split(":").map((x) => Number(x));
    const at = new Date(now);
    at.setHours(hh, mm, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  return null;
}

/** Tasks that are enabled and due at `now`. */
export function dueTasks(
  now: number,
  tasks: readonly SessionSchedule[],
): SessionSchedule[] {
  return tasks.filter(
    (t) => t.enabled && t.nextDueAt !== undefined && t.nextDueAt <= now,
  );
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Start the scheduler loop (idempotent). Runs in the main app window. */
export function startScheduler(): void {
  if (started) return;
  started = true;

  const tick = async (): Promise<void> => {
    try {
      const { useChatStore } = await import("../store/chatStore");
      const { useSessionDirectiveStore } = await import("../store/sessionDirectiveStore");
      const { sendMessage } = await import("../store/chatRuntime");
      const sessionId = useChatStore.getState().activeSessionId;
      if (sessionId) {
        const now = Date.now();
        const store = useSessionDirectiveStore.getState();
        const due = dueTasks(now, store.getSchedules(sessionId));
        for (const task of due) {
          // Reschedule before firing so a slow run does not re-fire the same task.
          const next = computeNextDueAt(now, task);
          if (next !== null) store.updateScheduleNext(sessionId, task.id, next);
          await sendMessage(task.prompt);
        }
      }
    } catch (e) {
      console.error("[scheduler] tick failed", e);
    } finally {
      timer = setTimeout(() => void tick(), TICK_MS);
    }
  };

  timer = setTimeout(() => void tick(), TICK_MS);
}

/** Stop the loop (test / teardown). */
export function stopScheduler(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  started = false;
}
