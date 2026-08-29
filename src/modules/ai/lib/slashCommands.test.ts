import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryRunSlashCommand, SLASH_COMMANDS } from "./slashCommands";
import { startPentestRun } from "@/modules/control/lib/startPentestRun";
import { listPipelines, runPipelineByName } from "./orchestrator";
import { useSessionDirectiveStore } from "../store/sessionDirectiveStore";
import { useChatStore } from "../store/chatStore";

vi.mock("@/modules/control/lib/startPentestRun", () => ({
  startPentestRun: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("./orchestrator", () => ({
  listPipelines: vi.fn().mockResolvedValue([]),
  runPipelineByName: vi.fn().mockResolvedValue({ ok: true }),
}));

beforeEach(() => {
  useChatStore.setState({ activeSessionId: "s1" });
  useSessionDirectiveStore.setState({ bySession: {} });
  vi.mocked(startPentestRun).mockClear();
  vi.mocked(listPipelines).mockClear();
  vi.mocked(runPipelineByName).mockClear();
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

  it("starts a pentest run via /pentest <target> [category]", () => {
    expect(SLASH_COMMANDS.pentest.invocation).toBe("/pentest");

    const withCategory = tryRunSlashCommand("/pentest example.com web");
    expect(withCategory.kind).toBe("handled");
    expect((withCategory as { toast?: string }).toast).toContain("example.com");
    expect(startPentestRun).toHaveBeenCalledWith("example.com", "web");

    vi.mocked(startPentestRun).mockClear();
    const recon = tryRunSlashCommand("/pentest 10.0.0.5");
    expect(recon.kind).toBe("handled");
    expect(startPentestRun).toHaveBeenCalledWith("10.0.0.5", "");
  });

  it("shows usage when /pentest has no target", () => {
    const out = tryRunSlashCommand("/pentest");
    expect(out.kind).toBe("handled");
    expect((out as { toast?: string }).toast).toMatch(/Usage/);
    expect(startPentestRun).not.toHaveBeenCalled();
  });

  it("runs a pipeline via /pipeline <name>", async () => {
    expect(SLASH_COMMANDS.pipeline.invocation).toBe("/pipeline");

    const out = tryRunSlashCommand("/pipeline release");
    expect(out.kind).toBe("handled");
    expect((out as { toast?: string }).toast).toContain("release");
    // The orchestrator is imported lazily (eager-budget guard), so the call
    // lands on a later microtask.
    await vi.waitFor(() =>
      expect(runPipelineByName).toHaveBeenCalledWith("release"),
    );
  });

  it("lists pipelines via /pipeline list", async () => {
    const out = tryRunSlashCommand("/pipeline list");
    expect(out.kind).toBe("handled");
    await vi.waitFor(() => expect(listPipelines).toHaveBeenCalled());
    expect(runPipelineByName).not.toHaveBeenCalled();
  });

  it("shows usage when /pipeline has no name", () => {
    const out = tryRunSlashCommand("/pipeline");
    expect(out.kind).toBe("handled");
    expect((out as { toast?: string }).toast).toMatch(/Usage/);
    expect(runPipelineByName).not.toHaveBeenCalled();
    expect(listPipelines).not.toHaveBeenCalled();
  });
});
