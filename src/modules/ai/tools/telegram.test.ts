import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTelegramStore } from "@/modules/telegram/store";
import { buildTelegramTools } from "./telegram";

vi.mock("@/modules/telegram/telegramApi", () => ({
  sendDocument: vi.fn().mockResolvedValue(undefined),
  sendTelegram: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/native", () => ({
  native: {
    canonicalize: vi.fn().mockImplementation(async (p: string) => p),
    readFileBase64: vi.fn().mockResolvedValue({
      data: "aGVsbG8gd29ybGQ=", // base64 for "hello world"
      size: 11,
      media_type: "text/plain",
      file_name: "test-report.txt",
    }),
  },
}));

vi.mock("../lib/security", () => ({
  checkReadableCanonical: vi
    .fn()
    .mockResolvedValue({ ok: true, canonical: "/workspace/test-report.txt" }),
}));

/**
 * Type-narrowing helper: a tool's `execute` result is a union that includes
 * `AsyncIterable` (tools may stream), so the object branches are not directly
 * accessible. Same convention as worktreeDiscovery.test.ts.
 */
const asRecord = (v: unknown) => v as Record<string, unknown>;

describe("telegram AI tools", () => {
  const mockCtx = {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    useTelegramStore.getState().setChatId(null);
    useTelegramStore.getState().setOwnerUserId(null);
  });

  it("returns an error if Telegram relay is not paired with a chat ID", async () => {
    const tools = buildTelegramTools(mockCtx);
    const docExec = tools.telegram_send_document.execute;
    if (!docExec) throw new Error("telegram_send_document execute missing");

    // biome-ignore lint/suspicious/noExplicitAny: mock tool call ctx
    const res = asRecord(await docExec({ path: "test-report.txt" }, {} as any));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Telegram relay is not currently paired");
  });

  it("automatically uses the paired chatId without asking the user", async () => {
    useTelegramStore.getState().setChatId("123456789");
    const { sendDocument } = await import("@/modules/telegram/telegramApi");

    const tools = buildTelegramTools(mockCtx);
    const docExec = tools.telegram_send_document.execute;
    if (!docExec) throw new Error("telegram_send_document execute missing");

    const res = asRecord(
      await docExec(
        { path: "test-report.txt", caption: "Here is your report" },
        // Adjacent to the `as any`, not to the call: a biome-ignore only
        // suppresses the NEXT line, and this call is wrapped across lines at the
        // 80-col limit. Above the `const` it suppressed nothing.
        // biome-ignore lint/suspicious/noExplicitAny: mock tool call ctx
        {} as any,
      ),
    );
    expect(res.ok).toBe(true);
    expect(res.chatId).toBe("123456789");
    expect(res.filename).toBe("test-report.txt");
    expect(sendDocument).toHaveBeenCalledWith(
      "123456789",
      expect.any(Uint8Array),
      "test-report.txt",
      "Here is your report",
      expect.any(AbortSignal),
    );
  });

  it("sends a direct text notification to the paired Telegram user", async () => {
    useTelegramStore.getState().setChatId("987654321");
    const { sendTelegram } = await import("@/modules/telegram/telegramApi");

    const tools = buildTelegramTools(mockCtx);
    const msgExec = tools.telegram_send_message.execute;
    if (!msgExec) throw new Error("telegram_send_message execute missing");

    const res = asRecord(
      await msgExec(
        { text: "Scan completed: 0 vulnerabilities found." },
        // See the note in the first test: the suppression has to sit on the line
        // directly above the `as any`, or it suppresses nothing.
        // biome-ignore lint/suspicious/noExplicitAny: mock tool call ctx
        {} as any,
      ),
    );
    expect(res.ok).toBe(true);
    expect(res.chatId).toBe("987654321");
    expect(sendTelegram).toHaveBeenCalledWith(
      "987654321",
      "Scan completed: 0 vulnerabilities found.",
      expect.any(AbortSignal),
    );
  });

  // The recipient is deliberately not a parameter. This schema is the first
  // place a caller could name another chat, and the tool reads files the user
  // can read, so an arbitrary target turned it into an exfiltration path.
  it("offers no way for the caller to name a target chat", () => {
    const tools = buildTelegramTools(mockCtx);
    for (const t of [
      tools.telegram_send_document,
      tools.telegram_send_message,
    ]) {
      const shape =
        (t.inputSchema as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape)).not.toContain("chatId");
    }
  });

  // Belt and braces: a smuggled `chatId` must not redirect the send either, so
  // the guarantee does not rest on the schema alone.
  it("ignores a smuggled chatId and still sends to the paired chat", async () => {
    useTelegramStore.getState().setChatId("111111111");
    const { sendTelegram } = await import("@/modules/telegram/telegramApi");

    const tools = buildTelegramTools(mockCtx);
    const msgExec = tools.telegram_send_message.execute;
    if (!msgExec) throw new Error("telegram_send_message execute missing");

    const res = asRecord(
      await msgExec(
        // Two separate `as any` on two separate lines, so two suppressions. One
        // directive covers exactly the next line, never the whole call — and a
        // line of prose that itself starts with the directive keyword is parsed
        // as one, which fails with "Failed to parse category".
        // biome-ignore lint/suspicious/noExplicitAny: passing an extra field on purpose
        { text: "hi", chatId: "999999999" } as any,
        // biome-ignore lint/suspicious/noExplicitAny: mock tool call ctx
        {} as any,
      ),
    );
    expect(res.ok).toBe(true);
    expect(res.chatId).toBe("111111111");
    expect(sendTelegram).toHaveBeenCalledWith(
      "111111111",
      "hi",
      expect.any(AbortSignal),
    );
  });
});
