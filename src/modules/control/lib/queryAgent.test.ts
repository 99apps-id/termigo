import { useChatStore } from "@/modules/ai/store/chatStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type QueryResult, runQuery } from "./queryAgent";

function failureMessage(result: QueryResult): string {
  if (result.ok) throw new Error("expected a failure result");
  return result.message;
}

type FakeMessage = {
  id: string;
  role: "user" | "assistant";
  parts: { type: string; text?: string }[];
};

const { sendMessage, getOrCreateChat } = vi.hoisted(() => ({
  sendMessage: vi.fn<(text: string) => Promise<boolean>>(),
  getOrCreateChat: vi.fn<(sessionId: string) => { messages: FakeMessage[] }>(),
}));

vi.mock("@/modules/ai/store/chatRuntime", () => ({
  sendMessage,
  getOrCreateChat,
}));

function setStatus(status: "idle" | "streaming" | "error"): void {
  useChatStore.setState({
    agentMeta: { ...useChatStore.getState().agentMeta, status },
  });
}

const fakeChat = () => ({
  messages: [] as FakeMessage[],
});

beforeEach(() => {
  useChatStore.setState({ activeSessionId: "s1" });
  setStatus("idle");
  sendMessage.mockReset().mockResolvedValue(true);
  getOrCreateChat.mockReset().mockImplementation(() => ({ messages: [] }));
});

describe("runQuery", () => {
  it("returns the last assistant text when the run settles", async () => {
    const chat = fakeChat();
    getOrCreateChat.mockReturnValue(chat);
    // The agent's answer arrives during the send.
    sendMessage.mockImplementation(async () => {
      chat.messages.push({
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "The answer" }],
      });
      return true;
    });

    const result = await runQuery("what changed?", 1000);
    expect(result).toEqual({ ok: true, text: "the answer" });
    // The prompt was wrapped with the read-only directive.
    const prompt = sendMessage.mock.calls[0][0] as string;
    expect(prompt).toContain("<termigo-query>");
    expect(prompt).toContain("read-only");
  });

  it("reports when nothing can be sent", async () => {
    sendMessage.mockResolvedValue(false);
    const result = await runQuery("hi", 500);
    expect(result.ok).toBe(false);
    expect(failureMessage(result)).toMatch(/no active chat/);
  });

  it("reports an agent error stop", async () => {
    useChatStore.setState({
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "error",
        error: "boom",
      },
    });
    const result = await runQuery("hi", 500);
    expect(result.ok).toBe(false);
    expect(failureMessage(result)).toContain("boom");
  });

  it("times out when the run never settles", async () => {
    setStatus("streaming");
    const result = await runQuery("hi", 50);
    expect(result.ok).toBe(false);
    expect(failureMessage(result)).toMatch(/timed out/);
  });

  it("rejects a blank prompt", async () => {
    const result = await runQuery("   ", 100);
    expect(result.ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
