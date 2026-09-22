import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/context";
import { createIsolatedWorktree } from "./subagentIsolation";
import { listSandboxes } from "./worktree";

vi.mock("./native", () => ({
  native: { shellSessionRun: vi.fn() },
}));
vi.mock("./sessionShell", () => ({
  getSessionShell: vi.fn(async () => 1),
  sessionShellKey: vi.fn(() => "key"),
}));

const { native } = await import("./native");
const shellSessionRun = vi.mocked(native.shellSessionRun);

function ctxWith(sessionId: string | null, root: string | null): ToolContext {
  return {
    getSessionId: () => sessionId,
    getWorkspaceRoot: () => root,
    getRemoteSession: () => null,
  } as unknown as ToolContext;
}

describe("createIsolatedWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The contract the caller relies on: it may fail, but it must never throw, or
  // an isolation attempt would take down a task that could simply run unisolated.
  it("refuses without a session instead of throwing", async () => {
    const r = await createIsolatedWorktree({
      ctx: ctxWith(null, "/repo"),
      label: "builder",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("chat session");
  });

  it("refuses without a workspace root instead of throwing", async () => {
    const r = await createIsolatedWorktree({
      ctx: ctxWith("s1", null),
      label: "builder",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("workspace root");
  });

  // git's own message is what tells "not a git repo" apart from a permissions
  // problem, so it has to survive into the reason.
  it("surfaces git's stderr when the branch cannot be created", async () => {
    shellSessionRun.mockResolvedValue({
      exit_code: 128,
      stdout: "",
      stderr:
        "fatal: not a git repository (or any of the parent directories)\n",
    });
    const r = await createIsolatedWorktree({
      ctx: ctxWith("s1", "/repo"),
      label: "builder",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("exit 128");
      expect(r.reason).toContain("not a git repository");
    }
  });

  // A process-level failure (missing shell, IPC error) must degrade the same way
  // as a git failure: the task runs, just without isolation.
  it("converts a thrown failure into a reason", async () => {
    shellSessionRun.mockRejectedValue(new Error("shell session unavailable"));
    const r = await createIsolatedWorktree({
      ctx: ctxWith("s1", "/repo"),
      label: "builder",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("shell session unavailable");
  });

  it("creates the worktree and registers it for worktree_list / discard", async () => {
    shellSessionRun.mockResolvedValue({ exit_code: 0, stdout: "", stderr: "" });
    const before = listSandboxes().length;

    const r = await createIsolatedWorktree({
      ctx: ctxWith("s1", "/repo"),
      label: "builder",
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      // Path is inside the workspace's ignored .termigo dir, and the branch is
      // namespaced, so a leftover one is identifiable.
       expect(r.worktreePath).toContain("/repo/.wt/");
      expect(r.worktreePath).toContain(r.sandboxId);
      expect(r.branchName).toBe(`termigo-sandbox/${r.sandboxId}`);
      // Registered, so the existing discard path can clean it up.
      expect(listSandboxes().length).toBe(before + 1);
    }

    // The command actually run is the proven one, built by worktree.ts.
    const command = shellSessionRun.mock.calls[0]?.[1] ?? "";
    expect(command).toContain("worktree add -b");
    expect(command).toContain("HEAD");
  });

  // Trailing separators are common from Explorer roots and would otherwise
  // produce a double slash in the path.
  it("does not double the separator when the root ends with one", async () => {
    shellSessionRun.mockResolvedValue({ exit_code: 0, stdout: "", stderr: "" });
    const r = await createIsolatedWorktree({
      ctx: ctxWith("s1", "/repo/"),
      label: "builder",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.worktreePath).not.toContain("//");
  });

  it("serializes concurrent worktree creation calls", async () => {
    let running = 0;
    let maxRunning = 0;
    shellSessionRun.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return { exit_code: 0, stdout: "", stderr: "" };
    });

    const [r1, r2] = await Promise.all([
      createIsolatedWorktree({ ctx: ctxWith("s1", "/repo"), label: "w1" }),
      createIsolatedWorktree({ ctx: ctxWith("s1", "/repo"), label: "w2" }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(maxRunning).toBe(1);
  });
});
