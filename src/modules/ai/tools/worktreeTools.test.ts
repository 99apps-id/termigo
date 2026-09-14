import { beforeEach, describe, expect, it } from "vitest";
import { clearSandboxes } from "../lib/worktree";
import { buildWorktreeTools } from "./worktreeTools";

describe("worktreeTools", () => {
  beforeEach(() => {
    clearSandboxes();
  });

  it("handles complete worktree lifecycle: create -> list -> diff -> merge", async () => {
    const tools = buildWorktreeTools();

    // 1. Create
    const createRes = await tools.worktree_create.execute(
      { taskLabel: "perf-test", description: "Optimize query speed" },
      { toolCallId: "call-1", messages: [] }
    );
    expect(createRes.status).toBe("created");
    expect(createRes.sandboxId).toBe("perf-test");
    expect(createRes.setupCommand).toContain("git worktree add");

    // 2. List
    const listRes = await tools.worktree_list.execute({}, { toolCallId: "call-2", messages: [] });
    expect(listRes.total).toBe(1);
    expect(listRes.sandboxes[0].id).toBe("perf-test");

    // 3. Diff
    const diffRes = await tools.worktree_diff.execute(
      { sandboxId: "perf-test", conciseStatOnly: true },
      { toolCallId: "call-3", messages: [] }
    );
    expect(diffRes.command).toContain("diff --stat");

    // 4. Merge
    const mergeRes = await tools.worktree_merge.execute(
      { sandboxId: "perf-test", squash: true },
      { toolCallId: "call-4", messages: [] }
    );
    expect(mergeRes.status).toBe("merge_prepared");
    expect(mergeRes.mergeCommand).toContain("git merge --squash");

    // Check list again - sandbox should be unregistered
    const listAfter = await tools.worktree_list.execute({}, { toolCallId: "call-5", messages: [] });
    expect(listAfter.total).toBe(0);
  });

  it("discards an isolated worktree", async () => {
    const tools = buildWorktreeTools();
    await tools.worktree_create.execute({ taskLabel: "failed-attempt" }, { toolCallId: "c1", messages: [] });

    const discardRes = await tools.worktree_discard.execute(
      { sandboxId: "failed-attempt" },
      { toolCallId: "c2", messages: [] }
    );
    expect(discardRes.status).toBe("discarded");
    expect(discardRes.cleanupCommand).toContain("git worktree remove");
  });
});
