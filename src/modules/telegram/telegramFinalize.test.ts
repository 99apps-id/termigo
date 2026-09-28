import { beforeEach, describe, expect, it, vi } from "vitest";

// The finalize path is where a failed delivery used to become a silent one. The
// card is edited in place, and the answer was recorded as delivered whether or
// not the edit or the follow-up chunks actually landed. These tests pin the
// return value that lets the mirror retry, and the whole-answer fallback.
vi.mock("./keyring", () => ({
  getTelegramToken: vi.fn().mockResolvedValue("mock_token_123"),
  getTelegramOwner: vi.fn().mockResolvedValue(null),
  setTelegramToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return null;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("./telegramApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegramApi")>();
  return {
    ...actual,
    sendTelegram: vi.fn(),
    editProgressMessage: vi.fn(),
  };
});

import { _testOnly } from "./bot";
import { editProgressMessage, sendTelegram } from "./telegramApi";

const { finalizeStreamedMessage } = _testOnly;
const edit = vi.mocked(editProgressMessage);
const send = vi.mocked(sendTelegram);

/** Long enough to need more than one Telegram message. */
const LONG_ANSWER = "line of text\n".repeat(400);

describe("finalizeStreamedMessage", () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    edit.mockReset();
    send.mockReset();
  });

  it("edits the card in place and does not post the answer twice", async () => {
    edit.mockResolvedValue(true);

    await expect(
      finalizeStreamedMessage(1, 42, "one short answer", signal),
    ).resolves.toBe(true);

    expect(edit).toHaveBeenCalledWith(1, 42, "one short answer", signal);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the whole answer when the card refuses the edit", async () => {
    edit.mockResolvedValue(false);
    send.mockResolvedValue(undefined);

    await expect(
      finalizeStreamedMessage(1, 42, "answer the card refuses", signal),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(1, "answer the card refuses", signal);
  });

  // THE regression: a refused edit plus a failed send used to be indistinguishable
  // from success, so the caller marked the message seen and the chat kept a
  // prefix of the answer with nothing left to deliver the rest.
  it("reports failure when neither the edit nor the fallback send lands", async () => {
    edit.mockResolvedValue(false);
    send.mockRejectedValue(new Error("429 Too Many Requests"));

    await expect(
      finalizeStreamedMessage(1, 42, "never arrives", signal),
    ).resolves.toBe(false);
  });

  it("reports failure when a follow-up chunk does not land", async () => {
    edit.mockResolvedValue(true);
    send.mockRejectedValue(new Error("network"));

    await expect(
      finalizeStreamedMessage(1, 42, LONG_ANSWER, signal),
    ).resolves.toBe(false);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("stops finalizing chunks once the run was aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    edit.mockResolvedValue(true);
    send.mockResolvedValue(undefined);

    await expect(
      finalizeStreamedMessage(1, 42, LONG_ANSWER, ctrl.signal),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
