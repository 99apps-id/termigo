import { beforeEach, describe, expect, it, vi } from "vitest";

// The log plugin needs a webview; the assertions here are about the gate.
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
  debug: vi.fn().mockResolvedValue(undefined),
  trace: vi.fn().mockResolvedValue(undefined),
  attachConsole: vi.fn().mockResolvedValue(undefined),
  detachConsole: vi.fn().mockResolvedValue(undefined),
}));

// The continuation gate fabricates a "thinking" status before it schedules its
// bounded follow-up. A schedule that never sends (no provider key) must release
// it, or the session is stranded thinking forever with no run behind it.

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

// The nudge is dispatched through the session's `Chat`, so a fake chat seeded
// into the real `chats` map observes the send without dragging the provider
// layer into a policy test. `stop` is needed because `touchChat` evicts past
// the LRU cap and calls it.
const chatSend = vi.fn().mockResolvedValue(undefined);
const fakeChat = {
  messages: [],
  status: "ready",
  sendMessage: chatSend,
  stop: vi.fn(),
} as unknown as Chat<UIMessage>;

vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    getActiveProviderKey: () => "sk-test",
  };
});

import type { Chat, UIMessage } from "ai";
import { chats, useChatStore } from "./chatStore";
import { requestContinuationNudge } from "./chatRuntime";

/** The nudge text out of the message object Chat.sendMessage received. */
function textOf(arg: unknown): string {
  const parts = (arg as { parts?: Array<{ text?: string }> }).parts ?? [];
  return String(parts[0]?.text ?? "");
}

function lastStep(
  over: Partial<{
    text: string;
    finishReason: string | undefined;
    usedTools: boolean;
  }> = {},
) {
  return {
    text: "",
    finishReason: "stop",
    usedTools: true,
    ...over,
  };
}

describe("requestContinuationNudge", () => {
  let seq = 0;
  /** A session id no other test has used: the per-session budgets live for the
   *  module's lifetime and are only cleared by a fresh task. */
  function freshSession(): string {
    const id = `session-cont-${++seq}`;
    chats.set(id, fakeChat);
    useChatStore.setState({
      activeSessionId: id,
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "idle",
        stoppedByUser: false,
        stopReason: null,
        error: null,
      },
    });
    useChatStore.setState({ steerQueue: { pending: [] } });
    return id;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    chatSend.mockResolvedValue(undefined);
    // Start from an empty registry: `touchChat` evicts past the LRU cap, and a
    // stale entry from an earlier test would be stopped mid-assertion.
    chats.clear();
  });

  it("nudges an empty final reply", async () => {
    const id = freshSession();
    const ok = requestContinuationNudge(id, {
      stopReason: null,
      aborted: false,
      lastStep: lastStep(),
    });
    expect(ok).toBe(true);
    await vi.runAllTimersAsync();
    expect(chatSend).toHaveBeenCalledTimes(1);

    expect(textOf(chatSend.mock.calls[0][0])).toContain(
      "output budget was consumed by reasoning",
    );
  });

  it("nudges a run the output budget cut, reported as step-cap", async () => {
    const id = freshSession();
    const ok = requestContinuationNudge(id, {
      stopReason: "step-cap",
      aborted: false,
      lastStep: lastStep({ text: "half an answer", finishReason: "length" }),
    });
    expect(ok).toBe(true);
    await vi.runAllTimersAsync();
    expect(textOf(chatSend.mock.calls[0][0])).toContain(
      "cut off by the output limit",
    );
  });

  it("nudges an announced action that never happened", async () => {
    const id = freshSession();
    const ok = requestContinuationNudge(id, {
      stopReason: null,
      aborted: false,
      lastStep: lastStep({ text: "Next I'll read approval.rs." }),
    });
    expect(ok).toBe(true);
    await vi.runAllTimersAsync();
    expect(textOf(chatSend.mock.calls[0][0])).toContain(
      "Next I'll read approval.rs.",
    );
  });

  it("stays silent on a clean finish", () => {
    expect(
      requestContinuationNudge(freshSession(), {
        stopReason: null,
        aborted: false,
        lastStep: lastStep({ text: "All done, tests pass." }),
      }),
    ).toBe(false);
  });

  it("never nudges a run a guard stopped on purpose", () => {
    for (const stopReason of [
      "tool-repetition",
      "no-progress",
      "cost-cap",
      "tool-error",
    ]) {
      expect(
        requestContinuationNudge(freshSession(), {
          stopReason,
          aborted: false,
          lastStep: lastStep(),
        }),
        stopReason,
      ).toBe(false);
    }
  });

  it("never nudges an aborted run", () => {
    expect(
      requestContinuationNudge(freshSession(), {
        stopReason: null,
        aborted: true,
        lastStep: lastStep(),
      }),
    ).toBe(false);
  });

  it("spends a bounded budget per kind instead of spinning", async () => {
    const id = freshSession();
    // MAX_EMPTY_REPLY_CONTINUATIONS is 2: two nudges, then the gate refuses.
    for (let i = 0; i < 2; i++) {
      expect(
        requestContinuationNudge(id, {
          stopReason: null,
          aborted: false,
          lastStep: lastStep(),
        }),
      ).toBe(true);

      await vi.runAllTimersAsync();
    }
    expect(chatSend).toHaveBeenCalledTimes(2);
    expect(
      requestContinuationNudge(id, {
        stopReason: null,
        aborted: false,
        lastStep: lastStep(),
      }),
    ).toBe(false);
    await vi.runAllTimersAsync();
    expect(chatSend).toHaveBeenCalledTimes(2);
  });

  it("refuses while the user is queuing a task", () => {
    const id = freshSession();
    useChatStore.getState().queueSteer({
      preview: "do this",
      parts: [{ type: "text", text: "do this" }],
    });
    expect(
      requestContinuationNudge(id, {
        stopReason: null,
        aborted: false,
        lastStep: lastStep(),
      }),
    ).toBe(false);
  });

  it("releases the fabricated thinking status when the follow-up cannot start", async () => {
    const id = freshSession();
    expect(
      requestContinuationNudge(id, {
        stopReason: null,
        aborted: false,
        lastStep: lastStep(),
      }),
    ).toBe(true);
    expect(useChatStore.getState().agentMeta.status).toBe("thinking");
    // The user stopped the session before the follow-up could start: the
    // status this gate fabricated must be released, or the session is stranded
    // thinking forever with no run behind it and every later message queues
    // behind nothing.
    useChatStore.setState({
      agentMeta: { ...useChatStore.getState().agentMeta, stoppedByUser: true },
    });
    await vi.runAllTimersAsync();
    expect(useChatStore.getState().agentMeta.status).toBe("idle");
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("refuses after the user stopped the session", () => {
    const id = freshSession();
    useChatStore.setState({
      agentMeta: { ...useChatStore.getState().agentMeta, stoppedByUser: true },
    });
    expect(
      requestContinuationNudge(id, {
        stopReason: null,
        aborted: false,
        lastStep: lastStep(),
      }),
    ).toBe(false);
  });
});
