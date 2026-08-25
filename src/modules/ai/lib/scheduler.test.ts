import { describe, expect, it } from "vitest";
import {
  parseScheduleWhen,
  computeNextDueAt,
  dueTasks,
  type ScheduleTiming,
} from "./scheduler";
import type { SessionSchedule } from "../store/sessionDirectiveStore";

describe("parseScheduleWhen", () => {
  it("parses intervals", () => {
    expect(parseScheduleWhen("every 30m")).toEqual({ intervalMs: 30 * 60_000 });
    expect(parseScheduleWhen("every 1h")).toEqual({ intervalMs: 3_600_000 });
    expect(parseScheduleWhen("every 5s")).toEqual({ intervalMs: 5_000 });
    expect(parseScheduleWhen("every 90 minutes")).toEqual({ intervalMs: 90 * 60_000 });
  });

  it("parses daily triggers", () => {
    expect(parseScheduleWhen("daily at 09:00")).toEqual({ dailyAt: "09:00" });
    expect(parseScheduleWhen("daily 09:30")).toEqual({ dailyAt: "09:30" });
  });

  it("returns no timing for unknown when", () => {
    expect(parseScheduleWhen("tomorrow morning")).toEqual({});
    expect(parseScheduleWhen("")).toEqual({});
  });
});

describe("computeNextDueAt", () => {
  it("bumps interval tasks forward", () => {
    const now = 1_000_000;
    expect(computeNextDueAt(now, { intervalMs: 60_000 })).toBe(1_060_000);
  });

  it("schedules a daily task at the next HH:MM", () => {
    // 2026-01-01 08:00 local.
    const now = new Date(2026, 0, 1, 8, 0, 0).getTime();
    const timing: ScheduleTiming = { dailyAt: "09:00" };
    expect(computeNextDueAt(now, timing)).toBe(
      new Date(2026, 0, 1, 9, 0, 0).getTime(),
    );
    // After the time has passed, rolls to the next day.
    const lateNow = new Date(2026, 0, 1, 10, 0, 0).getTime();
    expect(computeNextDueAt(lateNow, timing)).toBe(
      new Date(2026, 0, 2, 9, 0, 0).getTime(),
    );
  });

  it("returns null when there is no repeat rule", () => {
    expect(computeNextDueAt(Date.now(), {})).toBeNull();
  });
});

describe("dueTasks", () => {
  const base: SessionSchedule = {
    id: "a",
    when: "every 1h",
    prompt: "run",
    enabled: true,
    nextDueAt: 100,
  };

  it("returns only enabled tasks whose nextDueAt has passed", () => {
    const tasks: SessionSchedule[] = [
      base,
      { ...base, id: "b", nextDueAt: 200 },
      { ...base, id: "c", enabled: false, nextDueAt: 50 },
    ];
    expect(dueTasks(150, tasks).map((t) => t.id)).toEqual(["a"]);
  });
});
