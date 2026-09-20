import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";
import { clearSandboxes, registerSandbox } from "../lib/worktree";
import { buildWorktreeTools } from "./worktree";

// The registry is in memory, so a sandbox created before a restart is invisible
// to it while its directory and branch are still on disk. These tests pin the
// behaviour that makes those visible - and removable.
vi.mock("../lib/native", () => ({
  native: {
    gitListBranches: vi.fn(),
    shellSessionRun: vi.fn(),
  },
}));
vi.mock("../lib/sessionShell", () => ({
  getSessionShell: vi.fn(async () => 1),
  sessionShellKey: vi.fn(() => "key"),
}));

const { native } = await import("../lib/native");
const gitListBranches = vi.mocked(native.gitListBranches);
const shellSessionRun = vi.mocked(native.shellSessionRun);

function makeContext(): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getRemoteSession: () => null,
    getSessionId: () => "session",
    readCache: new Map(),
  } as unknown as ToolContext;
}

/** Type-narrowing helper: these tool result shapes are unions. */
const asRecord = (v: unknown) => v as Record<string, unknown>;

/**
 * A complete `CommandOutput`. The native contract has six fields; a partial
 * literal does not type-check against `vi.mocked`, and `*.test.ts` is excluded
 * from `pnpm check-types` so the gap would otherwise never be caught.
 */
function cmdOut(
  overrides: Partial<{
    stdout: string;
    stderr: string;
    exit_code: number | null;
    timed_out: boolean;
    truncated: boolean;
    cwd_after: string;
  }> = {},
) {
  return {
    stdout: "",
    stderr: "",
    exit_code: 0,
    timed_out: false,
    truncated: false,
    cwd_after: "/workspace",
    ...overrides,
  };
}

describe("worktree_list sees sandboxes this process did not create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSandboxes();
  });

  it("reports an on-disk sandbox from a previous run as orphaned", async () => {
    gitListBranches.mockResolvedValue({
      branches: [
        {
          name: "termigo-sandbox/old1",
          kind: "worktree",
          worktreePath: "/workspace/.termigo/worktrees/old1",
          isHead: false,
          isDetached: false,
        },
      ],
    });

    const res = asRecord(
      await buildWorktreeTools(makeContext()).worktree_list.execute?.({}, {} as never),
    );
    const sandboxes = res.sandboxes as Record<string, unknown>[];

    expect(res.count).toBe(1);
    expect(res.orphaned).toBe(1);
    expect(sandboxes[0]?.id).toBe("old1");
    // Named so a reader can tell it from a sandbox this process just created.
    expect(sandboxes[0]?.status).toBe("orphaned");
  });

  it("lists registry and disk side by side without duplicating one", async () => {
    registerSandbox({
      id: "mine",
      branchName: "termigo-sandbox/mine",
      worktreePath: "/workspace/.termigo/worktrees/mine",
      createdAt: Date.now(),
      status: "active",
    });
    gitListBranches.mockResolvedValue({
      branches: [
        // git reports the one in the registry too - it must not appear twice.
        {
          name: "termigo-sandbox/mine",
          kind: "worktree",
          worktreePath: "/workspace/.termigo/worktrees/mine",
          isHead: false,
          isDetached: false,
        },
        {
          name: "termigo-sandbox/old2",
          kind: "worktree",
          worktreePath: "/workspace/.termigo/worktrees/old2",
          isHead: false,
          isDetached: false,
        },
      ],
    });

    const res = asRecord(
      await buildWorktreeTools(makeContext()).worktree_list.execute?.({}, {} as never),
    );
    const ids = (res.sandboxes as Record<string, unknown>[]).map((s) => s.id).sort();

    expect(ids).toEqual(["mine", "old2"]);
    expect(res.count).toBe(2);
  });

  // A read-only listing must not fail because git did.
  it("still lists the registry when git errors", async () => {
    registerSandbox({
      id: "mine",
      branchName: "termigo-sandbox/mine",
      worktreePath: "/workspace/.termigo/worktrees/mine",
      createdAt: Date.now(),
      status: "active",
    });
    gitListBranches.mockRejectedValue(new Error("not a git repository"));

    const res = asRecord(
      await buildWorktreeTools(makeContext()).worktree_list.execute?.({}, {} as never),
    );

    expect(res.count).toBe(1);
    expect(res.orphaned).toBeUndefined();
  });
});

describe("worktree_discard can remove an orphan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSandboxes();
  });

  // Reporting an orphan that can never be removed would be a dead end: visible,
  // and still stuck.
  it("removes a sandbox that is only on disk", async () => {
    gitListBranches.mockResolvedValue({
      branches: [
        {
          name: "termigo-sandbox/old3",
          kind: "worktree",
          worktreePath: "/workspace/.termigo/worktrees/old3",
          isHead: false,
          isDetached: false,
        },
      ],
    });
    shellSessionRun.mockResolvedValue(cmdOut());

    const res = asRecord(
      await buildWorktreeTools(makeContext()).worktree_discard.execute?.(
        { sandbox_id: "old3" },
        {} as never,
      ),
    );

    expect(res.status).toBe("discarded");
    expect(res.branch).toBe("termigo-sandbox/old3");
    // It used the DISCOVERED path, not an empty one.
    const commands = shellSessionRun.mock.calls.map((c) => c[1]);
    expect(commands[0]).toContain("worktree remove");
    expect(commands[0]).toContain("/workspace/.termigo/worktrees/old3");
  });

  it("still refuses an id that is nowhere", async () => {
    gitListBranches.mockResolvedValue({ branches: [] });

    const res = asRecord(
      await buildWorktreeTools(makeContext()).worktree_discard.execute?.(
        { sandbox_id: "nope" },
        {} as never,
      ),
    );

    expect(String(res.error)).toContain("not found");
    expect(shellSessionRun).not.toHaveBeenCalled();
  });
});
