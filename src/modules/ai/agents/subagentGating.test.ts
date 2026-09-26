import { beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../lib/native";
import {
  gate,
  MAX_CONSECUTIVE_DENIALS,
  newFilesOnly,
  normalizeTargetKey,
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
    getState: vi.fn(() => ({
      rules: [],
    })),
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
    vi.mocked(native.readFile).mockReset();
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
    vi.mocked(native.readFile).mockResolvedValue("step 1 content");
    const step2 = await guarded.execute(
      { path: "/workspace/generated.code" } as never,
      {} as never,
    );

    expect(step2).toEqual({ success: true });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("allows subagents to update self-created files when path spelling differs", async () => {
    vi.mocked(native.readFile).mockRejectedValueOnce(new Error("not found"));
    const inner = vi.fn().mockResolvedValue({ success: true });
    const guarded = newFilesOnly({ execute: inner });

    // Step 1: creates file using relative dot-slash path
    await guarded.execute(
      { path: "./src/feature.ts" } as never,
      {} as never,
    );

    // Step 2: updates same file using Windows backslashes without leading dot-slash
    vi.mocked(native.readFile).mockResolvedValue("file content");
    const step2 = await guarded.execute(
      { path: "src\\feature.ts" } as never,
      {} as never,
    );

    expect(step2).toEqual({ success: true });
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeTargetKey", () => {
  it("normalizes path variants to a canonical key", () => {
    expect(normalizeTargetKey("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeTargetKey("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeTargetKey(".\\src\\a.ts")).toBe("src/a.ts");
    expect(normalizeTargetKey("././src/./a.ts")).toBe("src/a.ts");
    expect(normalizeTargetKey("src//a.ts")).toBe("src/a.ts");
    expect(normalizeTargetKey("C:\\project\\foo.ts")).toBe("c:/project/foo.ts");
    expect(normalizeTargetKey("c:/project/foo.ts")).toBe("c:/project/foo.ts");
  });

  it("resolves dot-dot segments so aliases share one key", () => {
    expect(normalizeTargetKey("src/../src/a.ts")).toBe("src/a.ts");
    expect(normalizeTargetKey("./src/b/../b/c.ts")).toBe("src/b/c.ts");
    // Leading .. escapes the root and is preserved, never collapsed away.
    expect(normalizeTargetKey("../shared/a.ts")).toBe("../shared/a.ts");
    expect(normalizeTargetKey("c:/project/../other/a.ts")).toBe("c:/other/a.ts");
  });
});

describe("gate & breaker", () => {
  // termigo-neo: no gates. runSubagent hands every tool to the subagent
  // directly, so nothing ever routes through the approval queue.
  it("subagentToolNeedsGate lets every tool through without gating", () => {
    expect(subagentToolNeedsGate("bash_run", { needsApproval: true })).toBe(false);
    expect(subagentToolNeedsGate("read_file", { needsApproval: false })).toBe(false);
  });

  it(`never asks the user and never trips the breaker (${MAX_CONSECUTIVE_DENIALS} denials stay at zero)`, async () => {
    const breaker: DenialBreaker = {
      denials: 0,
      tripped: false,
      trip: vi.fn(() => {
        breaker.tripped = true;
      }),
    };

    const inner = vi.fn().mockResolvedValue({ ran: true });
    const tool = gate({ execute: inner }, "bash_run", "builder #1", breaker);

    const { useApprovalQueue } = await import("../store/approvalQueueStore");
    const request = vi.spyOn(useApprovalQueue.getState(), "request");

    for (let i = 0; i < MAX_CONSECUTIVE_DENIALS; i++) {
      const res = (await tool.execute({} as never, {} as never)) as {
        ran?: boolean;
      };
      expect(res).toEqual({ ran: true });
    }

    expect(inner).toHaveBeenCalledTimes(MAX_CONSECUTIVE_DENIALS);
    expect(request).not.toHaveBeenCalled();
    expect(breaker.denials).toBe(0);
    expect(breaker.tripped).toBe(false);
    expect(breaker.trip).not.toHaveBeenCalled();
  });

  it("a project deny beats a session allowance", async () => {
    const { useApprovalRulesStore } = await import(
      "../store/approvalRulesStore"
    );
    vi.mocked(useApprovalRulesStore.getState).mockReturnValueOnce({
      rules: [{ tools: ["bash_run"], action: "deny" }],
    });
    const { isSessionAllowed } = await import("../store/approvalQueueStore");
    vi.mocked(isSessionAllowed).mockReturnValueOnce(true);
    const inner = vi.fn();
    const breaker: DenialBreaker = {
      denials: 0,
      tripped: false,
      trip: vi.fn(),
    };
    const tool = gate({ execute: inner }, "bash_run", "builder #1", breaker);
    const res = (await tool.execute(
      { command: "rm -rf /tmp/x" } as never,
      {} as never,
    )) as { error?: string };
    expect(res.error).toContain("project approval rule");
    expect(inner).not.toHaveBeenCalled();
  });
});
