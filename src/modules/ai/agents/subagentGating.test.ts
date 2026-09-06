import { beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../lib/native";
import {
  gate,
  newFilesOnly,
  subagentToolNeedsGate,
  type DenialBreaker,
} from "./subagentGating";

vi.mock("../lib/native", () => ({
  native: {
    readFile: vi.fn(),
  },
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: vi.fn(() => ({
      agentAlwaysAllowedTools: [],
      agentApprovalMode: "prompt",
      enforcePentestScope: false,
      pentestScope: [],
      autoApproveInScopeScans: false,
    })),
  },
}));

vi.mock("@/modules/settings/store", () => ({
  setAgentAlwaysAllowedTools: vi.fn(),
}));

vi.mock("../store/approvalQueueStore", () => ({
  isSessionAllowed: vi.fn(() => false),
  rememberSessionAllowed: vi.fn(),
  useApprovalQueue: {
    getState: () => ({
      request: vi.fn(),
    }),
  },
}));

vi.mock("../store/approvalRulesStore", () => ({
  useApprovalRulesStore: {
    getState: () => ({
      rules: [],
    }),
  },
}));

vi.mock("../store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      live: {
        getRemoteSession: () => null,
      },
    }),
  },
}));

vi.mock("../store/planStore", () => ({
  usePlanStore: {
    getState: () => ({
      active: false,
    }),
  },
}));

describe("newFilesOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks writing when file already exists", async () => {
    vi.mocked(native.readFile).mockResolvedValue("existing content");
    const inner = vi.fn().mockResolvedValue({ success: true });
    const guarded = newFilesOnly({ execute: inner });

    const result = (await guarded.execute(
      { path: "/workspace/foo.txt" } as never,
      {} as never,
    )) as { error?: string };

    expect(result.error).toContain("already exists");
    expect(inner).not.toHaveBeenCalled();
  });

  it("allows writing when file does not exist", async () => {
    vi.mocked(native.readFile).mockRejectedValue(new Error("not found"));
    const inner = vi.fn().mockResolvedValue({ success: true });
    const guarded = newFilesOnly({ execute: inner });

    const result = await guarded.execute(
      { path: "/workspace/new.txt" } as never,
      {} as never,
    );

    expect(result).toEqual({ success: true });
    expect(inner).toHaveBeenCalled();
  });

  it("allows overwriting when overwrite: true is explicitly passed", async () => {
    vi.mocked(native.readFile).mockResolvedValue("existing content");
    const inner = vi.fn().mockResolvedValue({ success: true });
    const guarded = newFilesOnly({ execute: inner });

    const result = await guarded.execute(
      { path: "/workspace/foo.txt", overwrite: true } as never,
      {} as never,
    );

    expect(result).toEqual({ success: true });
    expect(inner).toHaveBeenCalled();
  });

  it("allows subagents to write and update markdown report files", async () => {
    vi.mocked(native.readFile).mockResolvedValue("prior report");
    const inner = vi.fn().mockResolvedValue({ success: true });
    const guarded = newFilesOnly({ execute: inner });

    const result = await guarded.execute(
      { path: "/workspace/audit_report.md" } as never,
      {} as never,
    );

    expect(result).toEqual({ success: true });
    expect(inner).toHaveBeenCalled();
  });

  it("allows subagents to update files they created during the same run", async () => {
    vi.mocked(native.readFile).mockRejectedValueOnce(new Error("not found"));
    const inner = vi.fn().mockResolvedValue({ success: true });
    const guarded = newFilesOnly({ execute: inner });

    // Step 1: creates file
    await guarded.execute(
      { path: "/workspace/generated.code" } as never,
      {} as never,
    );

    // Step 2: updates same file later in the run even though file now exists
    vi.mocked(native.readFile).mockResolvedValueOnce("step 1 content");
    const step2 = await guarded.execute(
      { path: "/workspace/generated.code" } as never,
      {} as never,
    );

    expect(step2).toEqual({ success: true });
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("gate & breaker", () => {
  it("subagentToolNeedsGate identifies gating requirements", () => {
    expect(subagentToolNeedsGate("bash_run", { needsApproval: true })).toBe(true);
    expect(subagentToolNeedsGate("read_file", { needsApproval: false })).toBe(false);
  });

  it("increments denials and trips breaker on three denials", async () => {
    const breaker: DenialBreaker = {
      denials: 0,
      tripped: false,
      trip: vi.fn(() => {
        breaker.tripped = true;
      }),
    };

    const inner = vi.fn();
    const tool = gate({ execute: inner }, "bash_run", "builder #1", breaker);

    const { useApprovalQueue } = await import("../store/approvalQueueStore");
    vi.spyOn(useApprovalQueue.getState(), "request").mockResolvedValue("deny");

    // Deny 1
    const res1 = (await tool.execute({} as never, {} as never)) as { error?: string };
    expect(res1.error).toContain("denied by the user");
    expect(breaker.denials).toBe(1);
    expect(breaker.tripped).toBe(false);

    // Deny 2
    const res2 = (await tool.execute({} as never, {} as never)) as { error?: string };
    expect(res2.error).toContain("denied by the user");
    expect(breaker.denials).toBe(2);
    expect(breaker.tripped).toBe(false);

    // Deny 3 -> trips breaker
    const res3 = (await tool.execute({} as never, {} as never)) as { error?: string };
    expect(res3.error).toContain("denied by the user three times");
    expect(breaker.denials).toBe(3);
    expect(breaker.tripped).toBe(true);
    expect(breaker.trip).toHaveBeenCalled();
  });
});
