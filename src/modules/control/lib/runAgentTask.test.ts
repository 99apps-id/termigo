import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTask } from "./runAgentTask";

const { sendMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock("@/modules/ai/store/chatRuntime", () => ({ sendMessage }));

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(true);
});

describe("runAgentTask", () => {
  it("sends the trimmed prompt to the agent", async () => {
    const result = await runAgentTask("  fix the build  ");
    expect(result).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe("fix the build");
  });

  it("reports a failure when nothing can be sent", async () => {
    sendMessage.mockResolvedValue(false);
    const result = await runAgentTask("fix the build");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no active chat/);
  });

  it("rejects a blank prompt without touching the agent", async () => {
    const result = await runAgentTask("   ");
    expect(result.ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
