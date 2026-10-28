import { beforeEach, describe, expect, it, vi } from "vitest";

// The verify-on-stop gate fabricates a "thinking" status before it schedules
// its bounded follow-up. Every other exit from that schedule must release the
// fabricated status, otherwise the session is stranded thinking forever with
// no run behind it and every later message queues behind nothing.

vi.mock("../lib/verifyRunner", () => ({
  runAutoVerify: vi.fn().mockResolvedValue(null),
}));

// The chat store persists run metadata through the Tauri store plugin, which
// needs a browser environment. Only the release path is under test here, so
// the persistence layer is stubbed out.
vi.mock("../lib/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessions")>();
  return {
    ...actual,
    deleteRunInFlight: vi.fn().mockResolvedValue(undefined),
    deleteRunMeta: vi.fn().mockResolvedValue(undefined),
    saveRunMeta: vi.fn().mockResolvedValue(undefined),
    saveRunInFlight: vi.fn().mockResolvedValue(undefined),
    loadRunMeta: vi.fn().mockResolvedValue(null),
    loadRunInFlight: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@/modules/settings/preferences", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/settings/preferences")>();
  return {
    ...actual,
    usePreferencesStore: {
      ...actual.usePreferencesStore,
      getState: () => ({
        ...actual.usePreferencesStore.getState(),
        verifyOnStop: true,
      }),
    },
  };
});

const liveState = {
  getWorkspaceRoot: () => null as string | null,
  getCwd: () => null as string | null,
};

vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    useChatStore: {
      ...actual.useChatStore,
      getState: () => {
        const state = actual.useChatStore.getState();
        return { ...state, live: liveState };
      },
    },
  };
});

import { useChatStore } from "./chatStore";
import { requestVerifyNudge } from "./chatRuntime";

describe("requestVerifyNudge fabricated busy release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it("releases the fabricated thinking status when the workspace root is missing", async () => {
    useChatStore.setState({
      activeSessionId: "session-verify-busy",
      agentMeta: { ...useChatStore.getState().agentMeta, status: "idle" },
    });
    liveState.getWorkspaceRoot = () => null;

    const scheduled = requestVerifyNudge("session-verify-busy", {
      changedCodePaths: ["src/app.ts"],
      verifiedAfterLastEdit: false,
      claimedVerification: false,
    });
    expect(scheduled).toBe(true);

    // The gate sets "thinking" up front.
    expect(useChatStore.getState().agentMeta.status).toBe("thinking");

    await vi.advanceTimersByTimeAsync(5000);

    // Without the release the status stays "thinking" forever.
    expect(useChatStore.getState().agentMeta.status).toBe("idle");
  }, 30_000);
});
