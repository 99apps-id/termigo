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

export type ScheduleTiming = {
  intervalMs?: number;
  dailyAt?: string;
  cronExpr?: string;
};

function parseCronField(
  field: string,
  min: number,
  max: number,
): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) return null;
    const [rangePart, stepPart] = trimmed.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map(Number);
        if (
          !Number.isInteger(a) ||
          !Number.isInteger(b) ||
          a < min ||
          b > max ||
          a > b
        ) {
          return null;
        }
        start = a;
        end = b;
      } else {
        const n = Number(rangePart);
        if (!Number.isInteger(n) || n < min || n > max) return null;
        start = n;
        end = stepPart !== undefined ? max : n;
      }
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

function parseCronExpression(expr: string): {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
} | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dowsRaw = parseCronField(parts[4], 0, 7);
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null;
  const dows = new Set<number>();
  for (const d of dowsRaw) dows.add(d === 7 ? 0 : d);
  return { minutes, hours, doms, months, dows };
}

function nextCronFire(now: number, expr: string): number | null {
  const parsed = parseCronExpression(expr);
  if (!parsed) return null;
  const probe = new Date(now);
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  // Scan up to 366 days ahead (527,040 minutes).
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (
      parsed.months.has(probe.getMonth() + 1) &&
      parsed.doms.has(probe.getDate()) &&
      parsed.dows.has(probe.getDay()) &&
      parsed.hours.has(probe.getHours()) &&
      parsed.minutes.has(probe.getMinutes())
    ) {
      return probe.getTime();
    }
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null;
}

/** Parse the human `when` of a `/schedule` or cron job into a repeat rule.
 *  Supported: "every <N>s|m|h", "daily at HH:MM" / "daily HH:MM", and standard
 *  5-field cron expressions ("m h dom mon dow"). Unknown strings yield no auto
 *  timing (the task is still recorded, just not run). */
export function parseScheduleWhen(when: string): ScheduleTiming {
  const w = when.trim().toLowerCase();
  const interval = w.match(
    /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/,
  );
  if (interval) {
    const n = Number(interval[1]);
    const unit = interval[2][0];
    const ms =
      unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
    return { intervalMs: ms };
  }
  const daily = w.match(/^daily(?:\s+at)?\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const hh = daily[1].padStart(2, "0");
    const mm = daily[2];
    return { dailyAt: `${hh}:${mm}` };
  }
  if (parseCronExpression(w)) {
    return { cronExpr: w };
  }
  return {};
}

/** The next fire time, or null when the task has no repeat rule. */
export function computeNextDueAt(
  now: number,
  timing: ScheduleTiming,
): number | null {
  if (timing.intervalMs) return now + timing.intervalMs;
  if (timing.dailyAt) {
    const [hh, mm] = timing.dailyAt.split(":").map((x) => Number(x));
    const at = new Date(now);
    at.setHours(hh, mm, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  if (timing.cronExpr) {
    return nextCronFire(now, timing.cronExpr);
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
      const { useSessionDirectiveStore } = await import(
        "../store/sessionDirectiveStore"
      );
      const { sendMessage } = await import("../store/chatRuntime");
      const sessionId = useChatStore.getState().activeSessionId;
      if (sessionId) {
        const now = Date.now();
        const store = useSessionDirectiveStore.getState();
        const workspaceRoot = useChatStore.getState().live.getWorkspaceRoot();
        const due = dueTasks(now, store.getSchedules(sessionId, workspaceRoot));
        for (const task of due) {
          // Reschedule before firing so a slow run does not re-fire the same task.
          const next = computeNextDueAt(now, task);
          if (next !== null)
            store.updateScheduleNext(sessionId, workspaceRoot, task.id, next);
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
