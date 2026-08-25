import { beforeEach, describe, expect, it } from "vitest";
import { tryRunSlashCommand, SLASH_COMMANDS } from "./slashCommands";
import { useSessionDirectiveStore } from "../store/sessionDirectiveStore";
import { useChatStore } from "../store/chatStore";

beforeEach(() => {
  useChatStore.setState({ activeSessionId: "s1" });
  useSessionDirectiveStore.setState({ bySession: {} });
});

describe("slash commands", () => {
  it("registers /goal and /schedule", () => {
    expect(SLASH_COMMANDS.goal.invocation).toBe("/goal");
    expect(SLASH_COMMANDS.goal.label).toBe("Set the session goal");
    expect(SLASH_COMMANDS.schedule.invocation).toBe("/schedule");
    expect(SLASH_COMMANDS.schedule.label).toBe("Schedule a recurring task");
  });

  it("sets and clears a goal for the active session", () => {
    expect(tryRunSlashCommand("/goal fix auth").kind).toBe("handled");
    expect(useSessionDirectiveStore.getState().getGoal("s1")).toBe("fix auth");
    expect(tryRunSlashCommand("/goal off").kind).toBe("handled");
    expect(useSessionDirectiveStore.getState().getGoal("s1")).toBeNull();
  });

  it("reports usage when /goal has no argument", () => {
    const out = tryRunSlashCommand("/goal");
    expect(out.kind).toBe("handled");
    expect((out as { toast?: string }).toast).toMatch(/No goal set/);
  });

  it("adds, lists and removes schedules", () => {
    const add = tryRunSlashCommand("/schedule daily-at-9 run tests");
    expect(add.kind).toBe("handled");
    const schedules = useSessionDirectiveStore.getState().getSchedules("s1");
    expect(schedules).toHaveLength(1);
    expect(schedules[0].when).toBe("daily-at-9");
    expect(schedules[0].prompt).toBe("run tests");

    const list = tryRunSlashCommand("/schedule list");
    expect(list.kind).toBe("handled");
    expect((list as { toast?: string }).toast).toContain("daily-at-9");

    const rm = tryRunSlashCommand("/schedule remove 1");
    expect(rm.kind).toBe("handled");
    expect(useSessionDirectiveStore.getState().getSchedules("s1")).toHaveLength(0);
  });

  it("shows usage when /schedule is malformed", () => {
    const out = tryRunSlashCommand("/schedule just-one-word");
    expect(out.kind).toBe("handled");
    expect((out as { toast?: string }).toast).toMatch(/Usage/);
  });
});
